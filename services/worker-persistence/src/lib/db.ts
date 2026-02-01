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
  const borrowerKey = computeBorrowerKey(fullName, zip);

  // Determine status
  const status = borrower.missing_fields.length === 0 ? 'COMPLETE' : 'PARTIAL';

  // Upsert borrower
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

  const borrowerId = result.rows[0].borrower_id;

  // Link borrower to document
  await client.query(
    `INSERT INTO borrower_documents (borrower_id, document_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [borrowerId, documentId]
  );

  // Upsert addresses
  for (const addr of borrower.addresses) {
    const evidence = addr.evidence[0];
    await client.query(
      `INSERT INTO borrower_addresses (borrower_id, address_type, street1, street2, city, state, zip, document_id, page_number, quote)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        borrowerId,
        addr.type,
        addr.value.street1 || null,
        addr.value.street2 || null,
        addr.value.city || null,
        addr.value.state || null,
        addr.value.zip,
        evidence.document_id,
        evidence.page_number,
        evidence.quote,
      ]
    );
  }

  // Upsert income history
  for (const income of borrower.income_history) {
    const evidence = income.evidence[0];
    await client.query(
      `INSERT INTO borrower_incomes (borrower_id, source_type, employer, period_year, amount, currency, frequency, document_id, page_number, quote)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        borrowerId,
        income.source_type,
        income.employer || null,
        income.period.year,
        income.amount,
        income.currency,
        income.frequency || 'unknown',
        evidence.document_id,
        evidence.page_number,
        evidence.quote,
      ]
    );
  }

  // Upsert identifiers
  for (const id of borrower.identifiers) {
    const evidence = id.evidence[0];
    await client.query(
      `INSERT INTO borrower_identifiers (borrower_id, identifier_type, identifier_value, document_id, page_number, quote)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        borrowerId,
        id.type,
        id.value,
        evidence.document_id,
        evidence.page_number,
        evidence.quote,
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
    const evidence = propAddr.evidence[0];
    await client.query(
      `INSERT INTO application_addresses (application_id, address_type, street1, street2, city, state, zip, document_id, page_number, quote)
       VALUES ($1, 'property', $2, $3, $4, $5, $6, $7, $8, $9)`,
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
      ]
    );
  }

  // Upsert application identifiers
  for (const id of application.identifiers) {
    const evidence = id.evidence[0];
    await client.query(
      `INSERT INTO application_identifiers (application_id, identifier_type, identifier_value, document_id, page_number, quote)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        applicationId,
        id.type,
        id.value,
        evidence.document_id,
        evidence.page_number,
        evidence.quote,
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
    const evidence = application.loan_number.evidence[0];
    await client.query(
      `INSERT INTO application_party_evidence (application_id, borrower_id, document_id, page_number, quote)
       VALUES ($1, $2, $3, $4, $5)`,
      [applicationId, borrowerId, evidence.document_id, evidence.page_number, evidence.quote]
    );
  }
}

export { pool };
