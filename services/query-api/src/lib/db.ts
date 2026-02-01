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
} from '@stackpoint/shared';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || config.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30000,
});

/**
 * Get borrower by ID
 */
export async function getBorrowerById(borrowerId: string): Promise<BorrowerRecord | null> {
  const startTime = Date.now();

  try {
    // Get borrower base info
    const borrowerResult = await pool.query(
      `SELECT borrower_id, borrower_key, status, full_name, zip, last_correlation_id, updated_at
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
      conditions.push(`zip = $${paramIndex}`);
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
      SELECT borrower_id, borrower_key, status, full_name, zip, last_correlation_id, updated_at
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

  // Get addresses with evidence
  const addressesResult = await pool.query(
    `SELECT ba.address_type, ba.street1, ba.street2, ba.city, ba.state, ba.zip,
            d.document_id, d.source_filename, ba.page_number, ba.quote
     FROM borrower_addresses ba
     JOIN documents d ON ba.document_id = d.document_id
     WHERE ba.borrower_id = $1
     ORDER BY ba.address_type, ba.zip`,
    [borrowerId]
  );

  const addresses: BorrowerAddress[] = addressesResult.rows.map((row) => ({
    type: row.address_type,
    street1: row.street1,
    street2: row.street2,
    city: row.city,
    state: row.state,
    zip: row.zip,
    evidence: [
      {
        document_id: row.document_id,
        source_filename: row.source_filename,
        page_number: row.page_number,
        quote: row.quote,
      },
    ],
  }));

  // Get income history with evidence
  const incomesResult = await pool.query(
    `SELECT bi.source_type, bi.employer, bi.period_year, bi.amount, bi.currency, bi.frequency,
            d.document_id, d.source_filename, bi.page_number, bi.quote
     FROM borrower_incomes bi
     JOIN documents d ON bi.document_id = d.document_id
     WHERE bi.borrower_id = $1
     ORDER BY bi.period_year DESC, bi.source_type`,
    [borrowerId]
  );

  const income_history: BorrowerIncome[] = incomesResult.rows.map((row) => ({
    source_type: row.source_type,
    employer: row.employer,
    period_year: row.period_year,
    amount: parseFloat(row.amount),
    currency: row.currency,
    frequency: row.frequency,
    evidence: [
      {
        document_id: row.document_id,
        source_filename: row.source_filename,
        page_number: row.page_number,
        quote: row.quote,
      },
    ],
  }));

  // Get identifiers with evidence
  const identifiersResult = await pool.query(
    `SELECT bi.identifier_type, bi.identifier_value,
            d.document_id, d.source_filename, bi.page_number, bi.quote
     FROM borrower_identifiers bi
     JOIN documents d ON bi.document_id = d.document_id
     WHERE bi.borrower_id = $1
     ORDER BY bi.identifier_type, bi.identifier_value`,
    [borrowerId]
  );

  const identifiers: BorrowerIdentifier[] = identifiersResult.rows.map((row) => ({
    type: row.identifier_type,
    value: row.identifier_value,
    evidence: [
      {
        document_id: row.document_id,
        source_filename: row.source_filename,
        page_number: row.page_number,
        quote: row.quote,
      },
    ],
  }));

  // Get application links with evidence
  const applicationsResult = await pool.query(
    `SELECT a.application_id, a.loan_number, ap.role,
            ape.document_id, d.source_filename, ape.page_number, ape.quote
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
    borrower_key: borrower.borrower_key,
    status: borrower.status,
    full_name: borrower.full_name,
    zip: borrower.zip,
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

  // Get property address with evidence
  const addressResult = await pool.query(
    `SELECT aa.street1, aa.street2, aa.city, aa.state, aa.zip,
            d.document_id, d.source_filename, aa.page_number, aa.quote
     FROM application_addresses aa
     JOIN documents d ON aa.document_id = d.document_id
     WHERE aa.application_id = $1
     LIMIT 1`,
    [applicationId]
  );

  let property_address: ApplicationAddress;
  if (addressResult.rows.length > 0) {
    const row = addressResult.rows[0];
    property_address = {
      type: 'property',
      street1: row.street1,
      street2: row.street2,
      city: row.city,
      state: row.state,
      zip: row.zip,
      evidence: [
        {
          document_id: row.document_id,
          source_filename: row.source_filename,
          page_number: row.page_number,
          quote: row.quote,
        },
      ],
    };
  } else {
    // Fallback - no address found (should not happen in valid data)
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

  // Get identifiers with evidence
  const identifiersResult = await pool.query(
    `SELECT ai.identifier_type, ai.identifier_value,
            d.document_id, d.source_filename, ai.page_number, ai.quote
     FROM application_identifiers ai
     JOIN documents d ON ai.document_id = d.document_id
     WHERE ai.application_id = $1
     ORDER BY ai.identifier_type, ai.identifier_value`,
    [applicationId]
  );

  const identifiers: ApplicationIdentifier[] = identifiersResult.rows.map((row) => ({
    type: row.identifier_type,
    value: row.identifier_value,
    evidence: [
      {
        document_id: row.document_id,
        source_filename: row.source_filename,
        page_number: row.page_number,
        quote: row.quote,
      },
    ],
  }));

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
