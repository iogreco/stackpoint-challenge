/**
 * Database Queries
 *
 * Query functions for borrowers and applications with evidence assembly.
 */

import { Pool } from 'pg';
import {
  logger,
  config,
  dbQueryDurationHistogram,
  validateBorrower,
  validateApplication,
  getEvidenceWeight,
  type BorrowerRecord,
  type ApplicationRecord,
  type BorrowerAddress,
  type BorrowerIncome,
  type BorrowerIdentifier,
  type ApplicationLink,
  type DocumentRef,
  type ApplicationPartyRecord,
  type ApplicationAddress,
  type ApplicationIdentifier,
  type Evidence,
  type EvidenceSourceContext,
  type ConfidenceLevel,
} from '@stackpoint/shared';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || config.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30000,
});

const EPSILON = 1e-6;

/** Compute confidence level from favorable and unfavorable evidence weights (spec §4.3). */
function confidenceLevel(favorable: number, unfavorable: number): ConfidenceLevel {
  const score = favorable / Math.max(unfavorable, EPSILON);
  if (score > 1) return 'HIGH';
  if (score >= 1 - 1e-4 && score <= 1 + 1e-4) return 'MEDIUM';
  return 'LOW';
}

function normAddrKey(row: { street1?: string; city?: string; state?: string; zip?: string }): string {
  const s = (v: string | null | undefined) => (v ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
  return [s(row.street1), s(row.city), s(row.state), s(row.zip)].join('|');
}

function normIncomeKey(row: { source_type: string; employer?: string; period_year: number }): string {
  const e = (row.employer ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
  return `${row.source_type}|${e}|${row.period_year}`;
}

function normIdKey(row: { identifier_type: string; identifier_value: string }): string {
  const v = (row.identifier_value ?? '').trim().replace(/[\s-]+/g, '');
  return `${row.identifier_type}|${v}`;
}

/**
 * Get borrower by ID
 */
export async function getBorrowerById(borrowerId: string): Promise<BorrowerRecord | null> {
  const startTime = Date.now();

  try {
    // Get borrower base info (no borrower_key or root zip; zip is only in addresses)
    const borrowerResult = await pool.query(
      `SELECT borrower_id, status, full_name, last_correlation_id, updated_at
       FROM borrowers WHERE borrower_id = $1`,
      [borrowerId]
    );

    if (borrowerResult.rows.length === 0) {
      return null;
    }

    const borrower = borrowerResult.rows[0];
    const record = await assembleBorrowerRecord(borrower);

    const duration = (Date.now() - startTime) / 1000;
    dbQueryDurationHistogram.observe({ operation: 'get_borrower_by_id' }, duration);

    return record;
  } catch (error) {
    logger.error('Failed to get borrower', error, { borrowerId });
    throw error;
  }
}

/**
 * Search borrowers with pagination
 */
export async function searchBorrowers(
  filters: {
    name?: string;
    zip?: string;
    status?: string;
  },
  limit: number = 20,
  cursor?: string
): Promise<{ items: BorrowerRecord[]; next_cursor: string | null }> {
  const startTime = Date.now();

  try {
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (filters.name) {
      conditions.push(`LOWER(full_name) LIKE LOWER($${paramIndex})`);
      params.push(`%${filters.name}%`);
      paramIndex++;
    }

    if (filters.zip) {
      conditions.push(`borrower_id IN (SELECT borrower_id FROM borrower_addresses WHERE zip = $${paramIndex})`);
      params.push(filters.zip);
      paramIndex++;
    }

    if (filters.status) {
      conditions.push(`status = $${paramIndex}`);
      params.push(filters.status);
      paramIndex++;
    }

    if (cursor) {
      conditions.push(`borrower_id > $${paramIndex}`);
      params.push(cursor);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    params.push(limit + 1); // Fetch one extra to check for more
    const limitClause = `LIMIT $${paramIndex}`;

    const query = `
      SELECT borrower_id, status, full_name, last_correlation_id, updated_at
      FROM borrowers
      ${whereClause}
      ORDER BY borrower_id
      ${limitClause}
    `;

    const result = await pool.query(query, params);

    const hasMore = result.rows.length > limit;
    const borrowers = hasMore ? result.rows.slice(0, limit) : result.rows;

    const items = await Promise.all(borrowers.map(assembleBorrowerRecord));
    const nextCursor = hasMore ? borrowers[borrowers.length - 1].borrower_id : null;

    const duration = (Date.now() - startTime) / 1000;
    dbQueryDurationHistogram.observe({ operation: 'search_borrowers' }, duration);

    return { items, next_cursor: nextCursor };
  } catch (error) {
    logger.error('Failed to search borrowers', error, { filters });
    throw error;
  }
}

/**
 * Get application by loan number
 */
export async function getApplicationByLoanNumber(
  loanNumber: string
): Promise<ApplicationRecord | null> {
  const startTime = Date.now();

  try {
    // Get application base info
    const appResult = await pool.query(
      `SELECT application_id, loan_number, updated_at
       FROM applications WHERE loan_number = $1`,
      [loanNumber]
    );

    if (appResult.rows.length === 0) {
      return null;
    }

    const application = appResult.rows[0];
    const record = await assembleApplicationRecord(application);

    const duration = (Date.now() - startTime) / 1000;
    dbQueryDurationHistogram.observe({ operation: 'get_application_by_loan' }, duration);

    return record;
  } catch (error) {
    logger.error('Failed to get application', error, { loanNumber });
    throw error;
  }
}

/**
 * Assemble complete borrower record with related data
 */
async function assembleBorrowerRecord(borrower: any): Promise<BorrowerRecord> {
  const borrowerId = borrower.borrower_id;

  // Get addresses with evidence; group by logical address and compute confidence
  const addressesResult = await pool.query(
    `SELECT ba.address_type, ba.street1, ba.street2, ba.city, ba.state, ba.zip,
            d.document_id, d.source_filename, ba.page_number, ba.quote, ba.evidence_source_context, ba.proximity_score
     FROM borrower_addresses ba
     JOIN documents d ON ba.document_id = d.document_id
     WHERE ba.borrower_id = $1
     ORDER BY ba.address_type, ba.zip`,
    [borrowerId]
  );

  const addressGroups = new Map<
    string,
    { type: string; street1?: string; street2?: string; city?: string; state?: string; zip: string; evidence: Evidence[] }
  >();
  for (const row of addressesResult.rows) {
    const key = row.address_type + '|' + normAddrKey(row);
    const ev: Evidence = {
      document_id: row.document_id,
      source_filename: row.source_filename,
      page_number: row.page_number,
      quote: row.quote,
      ...(row.evidence_source_context != null && { evidence_source_context: row.evidence_source_context as EvidenceSourceContext }),
      ...(row.proximity_score != null && { proximity_score: row.proximity_score }),
    };
    if (!addressGroups.has(key)) {
      addressGroups.set(key, {
        type: row.address_type,
        street1: row.street1,
        street2: row.street2,
        city: row.city,
        state: row.state,
        zip: row.zip,
        evidence: [],
      });
    }
    addressGroups.get(key)!.evidence.push(ev);
  }
  const addressFavorable = new Map<string, number>();
  for (const [key, g] of addressGroups) {
    const w = g.evidence.reduce((s, e) => s + getEvidenceWeight(e.evidence_source_context), 0);
    addressFavorable.set(key, w);
  }
  const totalAddressWeight = [...addressFavorable.values()].reduce((a, b) => a + b, 0);
  const addresses: BorrowerAddress[] = [...addressGroups.entries()].map(([key, g]) => {
    const favorable = addressFavorable.get(key) ?? 0;
    const unfavorable = totalAddressWeight - favorable;
    const confidence = confidenceLevel(favorable, unfavorable);
    return {
      type: g.type as BorrowerAddress['type'],
      street1: g.street1,
      street2: g.street2,
      city: g.city,
      state: g.state,
      zip: g.zip,
      evidence: g.evidence,
      confidence,
    };
  });

  // Get income history with evidence; group by income_identity_key and compute confidence
  const incomesResult = await pool.query(
    `SELECT bi.source_type, bi.employer, bi.period_year, bi.amount, bi.currency, bi.frequency,
            d.document_id, d.source_filename, bi.page_number, bi.quote, bi.evidence_source_context, bi.proximity_score
     FROM borrower_incomes bi
     JOIN documents d ON bi.document_id = d.document_id
     WHERE bi.borrower_id = $1
     ORDER BY bi.period_year DESC, bi.source_type`,
    [borrowerId]
  );

  const incomeGroups = new Map<
    string,
    {
      source_type: string;
      employer?: string;
      period_year: number;
      amount: number;
      currency: string;
      frequency: string;
      evidence: Evidence[];
    }
  >();
  for (const row of incomesResult.rows) {
    const key = normIncomeKey(row);
    const ev: Evidence = {
      document_id: row.document_id,
      source_filename: row.source_filename,
      page_number: row.page_number,
      quote: row.quote,
      ...(row.evidence_source_context != null && { evidence_source_context: row.evidence_source_context as EvidenceSourceContext }),
      ...(row.proximity_score != null && { proximity_score: row.proximity_score }),
    };
    if (!incomeGroups.has(key)) {
      incomeGroups.set(key, {
        source_type: row.source_type,
        employer: row.employer,
        period_year: row.period_year,
        amount: parseFloat(row.amount),
        currency: row.currency,
        frequency: row.frequency ?? 'unknown',
        evidence: [],
      });
    }
    incomeGroups.get(key)!.evidence.push(ev);
  }
  const income_history: BorrowerIncome[] = [...incomeGroups.values()].map((g) => {
    const favorable = g.evidence.reduce((s, e) => s + getEvidenceWeight(e.evidence_source_context), 0);
    const confidence = confidenceLevel(favorable, 0);
    return {
      source_type: g.source_type as BorrowerIncome['source_type'],
      employer: g.employer,
      period_year: g.period_year,
      amount: g.amount,
      currency: g.currency,
      frequency: g.frequency as BorrowerIncome['frequency'],
      evidence: g.evidence,
      confidence,
    };
  });

  // Get identifiers with evidence; group by type + value and compute confidence (conflict domain = same type)
  const identifiersResult = await pool.query(
    `SELECT bi.identifier_type, bi.identifier_value,
            d.document_id, d.source_filename, bi.page_number, bi.quote, bi.evidence_source_context, bi.proximity_score
     FROM borrower_identifiers bi
     JOIN documents d ON bi.document_id = d.document_id
     WHERE bi.borrower_id = $1
     ORDER BY bi.identifier_type, bi.identifier_value`,
    [borrowerId]
  );

  const identifierGroups = new Map<
    string,
    { type: string; value: string; evidence: Evidence[] }
  >();
  for (const row of identifiersResult.rows) {
    const key = normIdKey(row);
    const ev: Evidence = {
      document_id: row.document_id,
      source_filename: row.source_filename,
      page_number: row.page_number,
      quote: row.quote,
      ...(row.evidence_source_context != null && { evidence_source_context: row.evidence_source_context as EvidenceSourceContext }),
      ...(row.proximity_score != null && { proximity_score: row.proximity_score }),
    };
    if (!identifierGroups.has(key)) {
      identifierGroups.set(key, { type: row.identifier_type, value: row.identifier_value, evidence: [] });
    }
    identifierGroups.get(key)!.evidence.push(ev);
  }
  const identifierFavorable = new Map<string, number>();
  const weightByType = new Map<string, number>();
  for (const [key, g] of identifierGroups) {
    const w = g.evidence.reduce((s, e) => s + getEvidenceWeight(e.evidence_source_context), 0);
    identifierFavorable.set(key, w);
    const t = g.type;
    weightByType.set(t, (weightByType.get(t) ?? 0) + w);
  }
  const identifiers: BorrowerIdentifier[] = [...identifierGroups.entries()].map(([key, g]) => {
    const favorable = identifierFavorable.get(key) ?? 0;
    const typeTotal = weightByType.get(g.type) ?? 0;
    const unfavorable = typeTotal - favorable;
    const confidence = confidenceLevel(favorable, unfavorable);
    return {
      type: g.type as BorrowerIdentifier['type'],
      value: g.value,
      evidence: g.evidence,
      confidence,
    };
  });

  // Get application links with evidence
  const applicationsResult = await pool.query(
    `SELECT a.application_id, a.loan_number, ap.role,
            ape.document_id, d.source_filename, ape.page_number, ape.quote, ape.evidence_source_context, ape.proximity_score
     FROM application_parties ap
     JOIN applications a ON ap.application_id = a.application_id
     LEFT JOIN application_party_evidence ape ON ap.application_id = ape.application_id AND ap.borrower_id = ape.borrower_id
     LEFT JOIN documents d ON ape.document_id = d.document_id
     WHERE ap.borrower_id = $1
     ORDER BY a.loan_number`,
    [borrowerId]
  );

  const applications: ApplicationLink[] = applicationsResult.rows.map((row) => ({
    application_id: row.application_id,
    loan_number: row.loan_number,
    role: row.role,
    evidence: row.document_id
      ? [
          {
            document_id: row.document_id,
            source_filename: row.source_filename,
            page_number: row.page_number,
            quote: row.quote,
            ...(row.evidence_source_context != null && { evidence_source_context: row.evidence_source_context }),
            ...(row.proximity_score != null && { proximity_score: row.proximity_score }),
          },
        ]
      : [],
  }));

  // Get documents
  const documentsResult = await pool.query(
    `SELECT d.document_id, d.source_filename, d.raw_uri, d.correlation_id, d.processed_at
     FROM documents d
     JOIN borrower_documents bd ON d.document_id = bd.document_id
     WHERE bd.borrower_id = $1
     ORDER BY d.document_id`,
    [borrowerId]
  );

  const documents: DocumentRef[] = documentsResult.rows.map((row) => ({
    document_id: row.document_id,
    source_filename: row.source_filename,
    raw_uri: row.raw_uri,
    correlation_id: row.correlation_id,
    processed_at: row.processed_at.toISOString(),
  }));

  const record: BorrowerRecord = {
    schema_version: '1.1.0',
    borrower_id: borrower.borrower_id,
    status: borrower.status,
    full_name: borrower.full_name,
    addresses,
    income_history,
    identifiers,
    applications,
    documents,
    last_correlation_id: borrower.last_correlation_id,
    updated_at: borrower.updated_at.toISOString(),
  };

  return record;
}

/**
 * Assemble complete application record with related data
 */
async function assembleApplicationRecord(application: any): Promise<ApplicationRecord> {
  const applicationId = application.application_id;

  // Get property address with evidence; group by logical address and compute confidence
  const addressResult = await pool.query(
    `SELECT aa.street1, aa.street2, aa.city, aa.state, aa.zip,
            d.document_id, d.source_filename, aa.page_number, aa.quote, aa.evidence_source_context, aa.proximity_score
     FROM application_addresses aa
     JOIN documents d ON aa.document_id = d.document_id
     WHERE aa.application_id = $1
     ORDER BY aa.zip`,
    [applicationId]
  );

  let property_address: ApplicationAddress;
  if (addressResult.rows.length > 0) {
    const addrGroups = new Map<string, { street1?: string; street2?: string; city?: string; state?: string; zip: string; evidence: Evidence[] }>();
    for (const row of addressResult.rows) {
      const key = normAddrKey(row);
      const ev: Evidence = {
        document_id: row.document_id,
        source_filename: row.source_filename,
        page_number: row.page_number,
        quote: row.quote,
        ...(row.evidence_source_context != null && { evidence_source_context: row.evidence_source_context as EvidenceSourceContext }),
        ...(row.proximity_score != null && { proximity_score: row.proximity_score }),
      };
      if (!addrGroups.has(key)) {
        addrGroups.set(key, {
          street1: row.street1,
          street2: row.street2,
          city: row.city,
          state: row.state,
          zip: row.zip,
          evidence: [],
        });
      }
      addrGroups.get(key)!.evidence.push(ev);
    }
    const first = [...addrGroups.values()][0];
    const favorable = first.evidence.reduce((s, e) => s + getEvidenceWeight(e.evidence_source_context), 0);
    property_address = {
      type: 'property',
      street1: first.street1,
      street2: first.street2,
      city: first.city,
      state: first.state,
      zip: first.zip,
      evidence: first.evidence,
      confidence: confidenceLevel(favorable, 0),
    };
  } else {
    property_address = {
      type: 'property',
      zip: '00000',
      evidence: [],
    };
  }

  // Get parties
  const partiesResult = await pool.query(
    `SELECT b.borrower_id, b.full_name, ap.role
     FROM application_parties ap
     JOIN borrowers b ON ap.borrower_id = b.borrower_id
     WHERE ap.application_id = $1
     ORDER BY ap.role, b.full_name`,
    [applicationId]
  );

  const parties: ApplicationPartyRecord[] = partiesResult.rows.map((row) => ({
    borrower_id: row.borrower_id,
    full_name: row.full_name,
    role: row.role,
  }));

  // Get identifiers with evidence; group by type+value and compute confidence
  const identifiersResult = await pool.query(
    `SELECT ai.identifier_type, ai.identifier_value,
            d.document_id, d.source_filename, ai.page_number, ai.quote, ai.evidence_source_context, ai.proximity_score
     FROM application_identifiers ai
     JOIN documents d ON ai.document_id = d.document_id
     WHERE ai.application_id = $1
     ORDER BY ai.identifier_type, ai.identifier_value`,
    [applicationId]
  );

  const appIdGroups = new Map<string, { type: string; value: string; evidence: Evidence[] }>();
  for (const row of identifiersResult.rows) {
    const key = normIdKey(row);
    const ev: Evidence = {
      document_id: row.document_id,
      source_filename: row.source_filename,
      page_number: row.page_number,
      quote: row.quote,
      ...(row.evidence_source_context != null && { evidence_source_context: row.evidence_source_context as EvidenceSourceContext }),
      ...(row.proximity_score != null && { proximity_score: row.proximity_score }),
    };
    if (!appIdGroups.has(key)) {
      appIdGroups.set(key, { type: row.identifier_type, value: row.identifier_value, evidence: [] });
    }
    appIdGroups.get(key)!.evidence.push(ev);
  }
  const appIdFavorable = new Map<string, number>();
  const appWeightByType = new Map<string, number>();
  for (const [key, g] of appIdGroups) {
    const w = g.evidence.reduce((s, e) => s + getEvidenceWeight(e.evidence_source_context), 0);
    appIdFavorable.set(key, w);
    appWeightByType.set(g.type, (appWeightByType.get(g.type) ?? 0) + w);
  }
  const identifiers: ApplicationIdentifier[] = [...appIdGroups.entries()].map(([key, g]) => {
    const favorable = appIdFavorable.get(key) ?? 0;
    const typeTotal = appWeightByType.get(g.type) ?? 0;
    const confidence = confidenceLevel(favorable, typeTotal - favorable);
    return {
      type: g.type as ApplicationIdentifier['type'],
      value: g.value,
      evidence: g.evidence,
      confidence,
    };
  });

  // Get documents
  const documentsResult = await pool.query(
    `SELECT d.document_id, d.source_filename, d.raw_uri, d.correlation_id, d.processed_at
     FROM documents d
     JOIN application_documents ad ON d.document_id = ad.document_id
     WHERE ad.application_id = $1
     ORDER BY d.document_id`,
    [applicationId]
  );

  const documents: DocumentRef[] = documentsResult.rows.map((row) => ({
    document_id: row.document_id,
    source_filename: row.source_filename,
    raw_uri: row.raw_uri,
    correlation_id: row.correlation_id,
    processed_at: row.processed_at.toISOString(),
  }));

  const record: ApplicationRecord = {
    schema_version: '1.1.0',
    application_id: application.application_id,
    loan_number: application.loan_number,
    property_address,
    parties,
    identifiers,
    documents,
    updated_at: application.updated_at.toISOString(),
  };

  return record;
}

export { pool };
