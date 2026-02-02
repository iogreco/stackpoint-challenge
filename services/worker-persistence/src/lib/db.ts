/**
 * Database Operations
 *
 * Handles upserts for borrowers, applications, and related data.
 */

import crypto from 'crypto';
import { Pool, PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import {
  logger,
  config,
  dbQueryDurationHistogram,
  type ExtractionResult,
  type BorrowerExtraction,
  type ApplicationExtraction,
  type Evidence,
} from '@stackpoint/shared';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || config.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30000,
});

/**
 * Compute borrower_key from normalized name and zip
 */
export function computeBorrowerKey(fullName: string, zip: string): string {
  const normalized = `${fullName.toLowerCase().trim()}|${zip.trim()}`;
  return crypto.createHash('sha256').update(normalized).digest('hex').substring(0, 32);
}

/** Normalize name for matching: trim, lowercase, collapse internal spaces. */
function normalizeName(fullName: string): string {
  return fullName.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Normalize zip to 5-digit prefix for comparison. */
function normalizeZip(zip: string): string {
  const digits = (zip || '').replace(/\D/g, '').slice(0, 5);
  return digits.length >= 5 ? digits : (zip || '').trim();
}

/** Extract visible (non-obfuscated) digits from SSN string. */
function ssnVisibleDigits(value: string): string {
  const s = (value || '').replace(/\D/g, '');
  return s.replace(/^x+$/i, '').length > 0 ? s.replace(/x/gi, '') : s;
}

/**
 * True if two SSN values overlap (visible digits at same positions match).
 * For partial (e.g. last-4 "5000") vs full (e.g. "999405000"), the partial's
 * digits must equal the same positions in the full (e.g. full's last 4 === "5000").
 */
function ssnOverlap(a: string, b: string): boolean {
  const va = ssnVisibleDigits(a);
  const vb = ssnVisibleDigits(b);
  if (va.length === 0 || vb.length === 0) return false;
  if (va.length === vb.length) return va === vb;
  const shorter = va.length < vb.length ? va : vb;
  const longer = va.length < vb.length ? vb : va;
  return longer.slice(-shorter.length) === shorter;
}

/** Normalize identifier value for comparison (trim, collapse spaces/dashes). */
function normalizeIdentifierValue(value: string): string {
  return (value || '').trim().replace(/[\s-]+/g, '');
}

/** True if payload identifier matches existing (same type and value overlap). */
function identifierMatch(
  payload: { type: string; value: string },
  existing: { identifier_type: string; identifier_value: string }
): boolean {
  if (payload.type !== existing.identifier_type) return false;
  if (payload.type === 'ssn') return ssnOverlap(payload.value, existing.identifier_value);
  return normalizeIdentifierValue(payload.value) === normalizeIdentifierValue(existing.identifier_value);
}

/** True if two zips match (same 5-digit prefix). */
function zipMatch(a: string, b: string): boolean {
  const za = normalizeZip(a);
  const zb = normalizeZip(b);
  return za.length >= 5 && zb.length >= 5 && za === zb;
}

/** Normalize string for address comparison: lowercase, collapse spaces, strip punctuation. */
function normalizeAddressPart(s: string | null | undefined): string {
  if (s == null || s === '') return '';
  return s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, '');
}

/** True if two addresses share a meaningful portion (city+state, or street1+city+state, or zip+state). */
function addressMeaningfulPortionMatch(
  addr1: { street1?: string; city?: string; state?: string; zip?: string },
  addr2: { street1?: string; city?: string; state?: string; zip?: string }
): boolean {
  const c1 = normalizeAddressPart(addr1.city);
  const s1 = normalizeAddressPart(addr1.state);
  const z1 = normalizeAddressPart(addr1.zip);
  const st1 = normalizeAddressPart(addr1.street1);
  const c2 = normalizeAddressPart(addr2.city);
  const s2 = normalizeAddressPart(addr2.state);
  const z2 = normalizeAddressPart(addr2.zip);
  const st2 = normalizeAddressPart(addr2.street1);
  if (c1 && s1 && c2 && s2 && c1 === c2 && s1 === s2) return true;
  if (z1 && s1 && z2 && s2 && z1.slice(0, 5) === z2.slice(0, 5) && s1 === s2) return true;
  if (st1 && c1 && s1 && st2 && c2 && s2 && st1 === st2 && c1 === c2 && s1 === s2) return true;
  return false;
}

/** Match threshold: at least one strong signal OR at least two medium signals. */
const MATCH_STRONG_THRESHOLD = 1;
const MATCH_MEDIUM_THRESHOLD = 2;

/** Normalize address for "same" comparison: lowercase, collapse spaces, strip punctuation. */
function normalizeAddressKey(addr: {
  street1?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}): string {
  const parts = [
    normalizeAddressPart(addr.street1),
    normalizeAddressPart(addr.city),
    normalizeAddressPart(addr.state),
    normalizeAddressPart(addr.zip),
  ];
  return parts.join('|');
}

/** Normalize employer for income identity. */
function normalizeEmployer(employer: string | null | undefined): string {
  if (employer == null || employer === '') return '';
  return employer
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s]/g, '');
}

/** Income identity key: source_type + employer_norm + period_year (spec §3.3.1). */
function incomeIdentityKey(income: {
  source_type: string;
  employer?: string | null;
  period: { year: number; start_date?: string; end_date?: string };
}): string {
  const employerNorm = normalizeEmployer(income.employer);
  return `${income.source_type}|${employerNorm}|${income.period.year}`;
}

/**
 * Persist extraction result to database
 */
export async function persistExtractionResult(
  extractionResult: ExtractionResult,
  correlationId: string
): Promise<void> {
  const client = await pool.connect();
  const startTime = Date.now();

  try {
    await client.query('BEGIN');

    const { document, borrowers, applications } = extractionResult;

    // Step 1: Upsert document
    await upsertDocument(client, document, correlationId);

    // Step 2: Process borrowers
    const borrowerIdMap = new Map<string, string>(); // borrower_ref -> borrower_id

    for (const borrower of borrowers) {
      const borrowerId = await upsertBorrower(client, borrower, document.document_id, correlationId);
      borrowerIdMap.set(borrower.borrower_ref, borrowerId);
    }

    // Step 3: Process applications
    for (const application of applications) {
      await upsertApplication(client, application, document.document_id, borrowerIdMap);
    }

    await client.query('COMMIT');

    const duration = (Date.now() - startTime) / 1000;
    dbQueryDurationHistogram.observe({ operation: 'persist_extraction' }, duration);

    logger.info('Persisted extraction result', {
      document_id: document.document_id,
      borrower_count: borrowers.length,
      application_count: applications.length,
      duration_seconds: duration,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Failed to persist extraction result', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Upsert document record
 */
async function upsertDocument(
  client: PoolClient,
  document: ExtractionResult['document'],
  correlationId: string
): Promise<void> {
  await client.query(
    `INSERT INTO documents (document_id, source_filename, raw_uri, source_system, source_doc_id, correlation_id, processed_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (document_id) DO UPDATE SET
       correlation_id = EXCLUDED.correlation_id,
       processed_at = NOW()`,
    [
      document.document_id,
      document.source_filename,
      document.raw_uri,
      document.source_system,
      document.source_doc_id,
      correlationId,
    ]
  );
}

/**
 * Resolve borrower: find existing by name + partial match, or create new.
 */
async function resolveBorrowerId(
  client: PoolClient,
  borrower: BorrowerExtraction,
  correlationId: string
): Promise<{ borrowerId: string; isNew: boolean }> {
  const fullName = borrower.full_name.value;
  const zip = borrower.zip.value;
  const normalizedName = normalizeName(fullName);
  const status = borrower.missing_fields.length === 0 ? 'COMPLETE' : 'PARTIAL';

  // Candidates: same normalized full name
  const candidatesResult = await client.query(
    `SELECT borrower_id, full_name, zip
     FROM borrowers
     WHERE LOWER(TRIM(REGEXP_REPLACE(full_name, E'\\s+', ' ', 'g'))) = $1`,
    [normalizedName]
  );

  if (candidatesResult.rows.length === 0) {
    const borrowerKey = computeBorrowerKey(fullName, zip);
    const result = await client.query(
      `INSERT INTO borrowers (borrower_key, status, full_name, zip, last_correlation_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       RETURNING borrower_id`,
      [borrowerKey, status, fullName, zip, correlationId]
    );
    return { borrowerId: result.rows[0].borrower_id, isNew: true };
  }

  const candidateIds = candidatesResult.rows.map((r: { borrower_id: string }) => r.borrower_id);

  // Fetch existing identifiers and addresses for candidates
  const identifiersResult = await client.query(
    `SELECT borrower_id, identifier_type, identifier_value
     FROM borrower_identifiers
     WHERE borrower_id = ANY($1::uuid[])`,
    [candidateIds]
  );
  const addressesResult = await client.query(
    `SELECT borrower_id, street1, city, state, zip
     FROM borrower_addresses
     WHERE borrower_id = ANY($1::uuid[])`,
    [candidateIds]
  );

  const identifiersByBorrower = new Map<string, { identifier_type: string; identifier_value: string }[]>();
  for (const row of identifiersResult.rows) {
    const list = identifiersByBorrower.get(row.borrower_id) || [];
    list.push({ identifier_type: row.identifier_type, identifier_value: row.identifier_value });
    identifiersByBorrower.set(row.borrower_id, list);
  }
  const addressesByBorrower = new Map<
    string,
    { street1?: string; city?: string; state?: string; zip?: string }[]
  >();
  for (const row of addressesResult.rows) {
    const list = addressesByBorrower.get(row.borrower_id) || [];
    list.push({
      street1: row.street1,
      city: row.city,
      state: row.state,
      zip: row.zip,
    });
    addressesByBorrower.set(row.borrower_id, list);
  }

  let bestId: string | null = null;
  let bestStrong = 0;
  let bestMedium = 0;

  for (const cand of candidatesResult.rows) {
    let strongCount = 0;
    let mediumCount = 0;

    if (zipMatch(zip, cand.zip)) mediumCount++;

    const existingIds = identifiersByBorrower.get(cand.borrower_id) || [];
    for (const payloadId of borrower.identifiers) {
      if (existingIds.some((ex) => identifierMatch(payloadId, ex))) {
        strongCount++;
        break;
      }
    }

    const existingAddrs = addressesByBorrower.get(cand.borrower_id) || [];
    for (const payloadAddr of borrower.addresses) {
      const v = payloadAddr.value;
      if (v && existingAddrs.some((ex) => addressMeaningfulPortionMatch(v, ex))) {
        mediumCount++;
        break;
      }
    }

    const meetsThreshold =
      strongCount >= MATCH_STRONG_THRESHOLD || mediumCount >= MATCH_MEDIUM_THRESHOLD;
    const isBetter =
      strongCount > bestStrong || (strongCount === bestStrong && mediumCount > bestMedium);
    if (meetsThreshold && (bestId === null || isBetter)) {
      bestStrong = strongCount;
      bestMedium = mediumCount;
      bestId = cand.borrower_id;
    }
  }

  if (
    bestId &&
    (bestStrong >= MATCH_STRONG_THRESHOLD || bestMedium >= MATCH_MEDIUM_THRESHOLD)
  ) {
    await client.query(
      `UPDATE borrowers SET status = CASE WHEN $2 = 'COMPLETE' OR status = 'COMPLETE' THEN 'COMPLETE' ELSE 'PARTIAL' END, last_correlation_id = $3, updated_at = NOW() WHERE borrower_id = $1`,
      [bestId, status, correlationId]
    );
    return { borrowerId: bestId, isNew: false };
  }

  const borrowerKey = computeBorrowerKey(fullName, zip);
  const result = await client.query(
    `INSERT INTO borrowers (borrower_key, status, full_name, zip, last_correlation_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (borrower_key) DO UPDATE SET
       status = CASE WHEN EXCLUDED.status = 'COMPLETE' OR borrowers.status = 'COMPLETE' THEN 'COMPLETE' ELSE 'PARTIAL' END,
       full_name = EXCLUDED.full_name,
       zip = EXCLUDED.zip,
       last_correlation_id = EXCLUDED.last_correlation_id,
       updated_at = NOW()
     RETURNING borrower_id`,
    [borrowerKey, status, fullName, zip, correlationId]
  );
  return { borrowerId: result.rows[0].borrower_id, isNew: true };
}

/**
 * Upsert borrower and related data
 */
async function upsertBorrower(
  client: PoolClient,
  borrower: BorrowerExtraction,
  documentId: string,
  correlationId: string
): Promise<string> {
  const fullName = borrower.full_name.value;
  const zip = borrower.zip.value;

  const { borrowerId, isNew } = await resolveBorrowerId(client, borrower, correlationId);

  // Link borrower to document
  await client.query(
    `INSERT INTO borrower_documents (borrower_id, document_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [borrowerId, documentId]
  );

  // Merge addresses: if same logical address exists, add evidence to it (new row with existing address values)
  const existingAddressesResult = await client.query(
    `SELECT address_type, street1, street2, city, state, zip FROM borrower_addresses WHERE borrower_id = $1`,
    [borrowerId]
  );
  const existingAddressKeys = new Map<string, { street1: string; street2: string; city: string; state: string; zip: string }>();
  for (const row of existingAddressesResult.rows) {
    const key = normalizeAddressKey(row) + '|' + row.address_type;
    existingAddressKeys.set(key, {
      street1: row.street1 ?? '',
      street2: row.street2 ?? '',
      city: row.city ?? '',
      state: row.state ?? '',
      zip: row.zip ?? '',
    });
  }
  for (const addr of borrower.addresses) {
    const evidence = addr.evidence?.[0];
    if (!evidence) {
      logger.warn('Skipping address without evidence', { borrowerId, address: addr });
      continue;
    }
    const payloadKey = normalizeAddressKey(addr.value) + '|' + addr.type;
    const canonical = existingAddressKeys.get(payloadKey);
    const street1 = canonical?.street1 ?? addr.value?.street1 ?? null;
    const street2 = canonical?.street2 ?? addr.value?.street2 ?? null;
    const city = canonical?.city ?? addr.value?.city ?? null;
    const state = canonical?.state ?? addr.value?.state ?? null;
    const zip = canonical?.zip ?? addr.value?.zip ?? null;
    if (!canonical) {
      existingAddressKeys.set(payloadKey, {
        street1: street1 ?? '',
        street2: street2 ?? '',
        city: city ?? '',
        state: state ?? '',
        zip: zip ?? '',
      });
    }
    await client.query(
      `INSERT INTO borrower_addresses (borrower_id, address_type, street1, street2, city, state, zip, document_id, page_number, quote, evidence_source_context)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        borrowerId,
        addr.type,
        street1,
        street2,
        city,
        state,
        zip,
        evidence.document_id,
        evidence.page_number,
        evidence.quote,
        evidence.evidence_source_context ?? null,
      ]
    );
  }

  // Merge income: if same income_identity_key exists, add evidence row (same logical income, new evidence)
  const existingIncomesResult = await client.query(
    `SELECT source_type, employer, period_year, amount, currency, frequency FROM borrower_incomes WHERE borrower_id = $1`,
    [borrowerId]
  );
  const existingIncomeKeys = new Set<string>();
  const existingIncomeCanonical = new Map<
    string,
    { employer: string | null; amount: number; currency: string; frequency: string }
  >();
  for (const row of existingIncomesResult.rows) {
    const key = `${row.source_type}|${normalizeEmployer(row.employer)}|${row.period_year}`;
    existingIncomeKeys.add(key);
    if (!existingIncomeCanonical.has(key)) {
      existingIncomeCanonical.set(key, {
        employer: row.employer ?? null,
        amount: parseFloat(row.amount),
        currency: row.currency,
        frequency: row.frequency ?? 'unknown',
      });
    }
  }
  for (const income of borrower.income_history) {
    const evidence = income.evidence?.[0];
    if (!evidence) {
      logger.warn('Skipping income without evidence', { borrowerId, income });
      continue;
    }
    const key = incomeIdentityKey(income);
    const canonical = existingIncomeCanonical.get(key);
    const employer = canonical?.employer ?? income.employer ?? null;
    const amount = canonical?.amount ?? income.amount;
    const currency = canonical?.currency ?? income.currency;
    const frequency = canonical?.frequency ?? income.frequency ?? 'unknown';
    if (!existingIncomeKeys.has(key)) {
      existingIncomeKeys.add(key);
      existingIncomeCanonical.set(key, { employer, amount, currency, frequency });
    }
    await client.query(
      `INSERT INTO borrower_incomes (borrower_id, source_type, employer, period_year, amount, currency, frequency, document_id, page_number, quote, evidence_source_context)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        borrowerId,
        income.source_type,
        employer,
        income.period.year,
        amount,
        currency,
        frequency,
        evidence.document_id,
        evidence.page_number,
        evidence.quote,
        evidence.evidence_source_context ?? null,
      ]
    );
  }

  // Merge identifiers: if same type + overlapping value exists, add evidence row (use existing value if more complete)
  const existingIdsResult = await client.query(
    `SELECT identifier_type, identifier_value FROM borrower_identifiers WHERE borrower_id = $1`,
    [borrowerId]
  );
  const existingIdByType = new Map<string, string>();
  for (const row of existingIdsResult.rows) {
    const k = row.identifier_type;
    if (!existingIdByType.has(k)) existingIdByType.set(k, row.identifier_value);
    else if (k === 'ssn' && row.identifier_value.replace(/x/gi, '').length > (existingIdByType.get(k) ?? '').replace(/x/gi, '').length)
      existingIdByType.set(k, row.identifier_value);
  }
  for (const id of borrower.identifiers) {
    const evidence = id.evidence?.[0];
    if (!evidence) {
      logger.warn('Skipping identifier without evidence', { borrowerId, identifier: id });
      continue;
    }
    const existingVal = existingIdByType.get(id.type);
    const useExisting =
      existingVal &&
      (id.type === 'ssn' ? ssnOverlap(id.value, existingVal) : normalizeIdentifierValue(id.value) === normalizeIdentifierValue(existingVal));
    const moreCompleteSsn =
      id.type === 'ssn' &&
      id.value.replace(/\D/g, '').replace(/x/gi, '').length > (existingVal ?? '').replace(/\D/g, '').replace(/x/gi, '').length;
    const value = useExisting
      ? moreCompleteSsn
        ? id.value
        : (existingVal ?? id.value)
      : id.value;
    if (!useExisting) existingIdByType.set(id.type, value);
    else if (moreCompleteSsn) existingIdByType.set(id.type, id.value);
    await client.query(
      `INSERT INTO borrower_identifiers (borrower_id, identifier_type, identifier_value, document_id, page_number, quote, evidence_source_context)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        borrowerId,
        id.type,
        value,
        evidence.document_id,
        evidence.page_number,
        evidence.quote,
        evidence.evidence_source_context ?? null,
      ]
    );
  }

  return borrowerId;
}

/**
 * Upsert application and related data
 */
async function upsertApplication(
  client: PoolClient,
  application: ApplicationExtraction,
  documentId: string,
  borrowerIdMap: Map<string, string>
): Promise<void> {
  const loanNumber = application.loan_number.value;

  // Upsert application
  const result = await client.query(
    `INSERT INTO applications (loan_number, updated_at)
     VALUES ($1, NOW())
     ON CONFLICT (loan_number) DO UPDATE SET
       updated_at = NOW()
     RETURNING application_id`,
    [loanNumber]
  );

  const applicationId = result.rows[0].application_id;

  // Link application to document
  await client.query(
    `INSERT INTO application_documents (application_id, document_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [applicationId, documentId]
  );

  // Upsert property address
  const propAddr = application.property_address;
  if (propAddr) {
    const evidence = propAddr.evidence?.[0];
    if (!evidence) {
      logger.warn('Skipping property address without evidence', { applicationId, propAddr });
    } else {
      await client.query(
      `INSERT INTO application_addresses (application_id, address_type, street1, street2, city, state, zip, document_id, page_number, quote, evidence_source_context)
       VALUES ($1, 'property', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        applicationId,
        propAddr.value.street1 || null,
        propAddr.value.street2 || null,
        propAddr.value.city || null,
        propAddr.value.state || null,
        propAddr.value.zip,
        evidence.document_id,
        evidence.page_number,
        evidence.quote,
        evidence.evidence_source_context ?? null,
      ]
    );
    }
  }

  // Upsert application identifiers
  for (const id of application.identifiers) {
    const evidence = id.evidence?.[0];
    if (!evidence) {
      logger.warn('Skipping application identifier without evidence', { applicationId, identifier: id });
      continue;
    }
    await client.query(
      `INSERT INTO application_identifiers (application_id, identifier_type, identifier_value, document_id, page_number, quote, evidence_source_context)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        applicationId,
        id.type,
        id.value,
        evidence.document_id,
        evidence.page_number,
        evidence.quote,
        evidence.evidence_source_context ?? null,
      ]
    );
  }

  // Upsert application parties
  for (const party of application.parties) {
    const borrowerId = borrowerIdMap.get(party.borrower_ref);
    if (!borrowerId) {
      logger.warn('Borrower ref not found for party', {
        borrower_ref: party.borrower_ref,
        loan_number: loanNumber,
      });
      continue;
    }

    await client.query(
      `INSERT INTO application_parties (application_id, borrower_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (application_id, borrower_id) DO UPDATE SET
         role = EXCLUDED.role`,
      [applicationId, borrowerId, party.role]
    );

    // Add party evidence from loan_number
    const evidence = application.loan_number.evidence?.[0];
    if (evidence) {
      await client.query(
        `INSERT INTO application_party_evidence (application_id, borrower_id, document_id, page_number, quote, evidence_source_context)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          applicationId,
          borrowerId,
          evidence.document_id,
          evidence.page_number,
          evidence.quote,
          evidence.evidence_source_context ?? null,
        ]
      );
    } else {
      logger.warn('Skipping party evidence - no loan_number evidence', { applicationId, borrowerId });
    }
  }
}

export { pool };
