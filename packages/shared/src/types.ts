/**
 * Shared TypeScript Types
 *
 * Types for the loan document extraction pipeline, matching JSON schemas in docs/contracts/
 */

// ============================================================================
// Evidence & Provenance
// ============================================================================

export interface Evidence {
  document_id: string;
  source_filename: string;
  page_number: number;
  quote: string;
}

export interface ValueWithEvidence<T> {
  value: T;
  evidence: Evidence[];
}

// ============================================================================
// Address Types
// ============================================================================

export type AddressType = 'current' | 'previous' | 'mailing' | 'property';

export interface AddressValue {
  street1?: string;
  street2?: string;
  city?: string;
  state?: string;
  zip: string;
}

export interface AddressExtraction {
  type: AddressType;
  value: AddressValue;
  evidence: Evidence[];
}

// ============================================================================
// Income Types
// ============================================================================

export type IncomeSourceType =
  | 'w2'
  | 'paystub'
  | 'tax_return_1040'
  | 'schedule_c'
  | 'bank_statement'
  | 'other';

export type IncomeFrequency =
  | 'annual'
  | 'monthly'
  | 'biweekly'
  | 'weekly'
  | 'daily'
  | 'unknown';

export interface IncomePeriod {
  year: number;
  start_date?: string;
  end_date?: string;
}

export interface IncomeExtraction {
  source_type: IncomeSourceType;
  employer?: string;
  period: IncomePeriod;
  amount: number;
  currency: string;
  frequency?: IncomeFrequency;
  evidence: Evidence[];
}

// ============================================================================
// Identifier Types
// ============================================================================

export type IdentifierType = 'loan_number' | 'account_number' | 'ssn' | 'ein' | 'other';

export interface IdentifierExtraction {
  type: IdentifierType;
  value: string;
  evidence: Evidence[];
}

// ============================================================================
// Field Names (for missing_fields)
// ============================================================================

export type FieldName =
  | 'borrower.full_name'
  | 'borrower.zip'
  | 'borrower.addresses'
  | 'borrower.income_history'
  | 'borrower.identifiers'
  | 'application.loan_number'
  | 'application.property_address'
  | 'application.parties';

// ============================================================================
// Borrower Extraction (per document)
// ============================================================================

export interface BorrowerExtraction {
  borrower_ref: string;
  full_name: ValueWithEvidence<string>;
  zip: ValueWithEvidence<string>;
  addresses: AddressExtraction[];
  income_history: IncomeExtraction[];
  identifiers: IdentifierExtraction[];
  missing_fields: FieldName[];
}

// ============================================================================
// Application Types
// ============================================================================

export type PartyRole = 'borrower' | 'co_borrower' | 'other';

export interface ApplicationParty {
  borrower_ref: string;
  role: PartyRole;
}

export interface ApplicationExtraction {
  application_ref: string;
  loan_number: ValueWithEvidence<string>;
  property_address: {
    value: AddressValue;
    evidence: Evidence[];
  };
  parties: ApplicationParty[];
  identifiers: IdentifierExtraction[];
  missing_fields: FieldName[];
}

// ============================================================================
// Extraction Result (per document)
// ============================================================================

export type ExtractionMode = 'text' | 'pdf_fallback';

export interface ExtractionMetadata {
  provider: 'openai';
  model: string;
  request_id: string;
  prompt_version: string;
}

export interface DocumentInfo {
  document_id: string;
  source_filename: string;
  raw_uri: string;
  source_system: string;
  source_doc_id: string;
  discovered_at?: string;
  source_updated_at?: string;
}

export interface ExtractionResult {
  schema_version: '1.1.0';
  correlation_id: string;
  document: DocumentInfo;
  extraction_mode: ExtractionMode;
  applications: ApplicationExtraction[];
  borrowers: BorrowerExtraction[];
  missing_fields: FieldName[];
  warnings?: string[];
  extraction_metadata: ExtractionMetadata;
  created_at: string;
}

// ============================================================================
// Borrower Record (read model)
// ============================================================================

export type BorrowerStatus = 'COMPLETE' | 'PARTIAL';

export interface BorrowerAddress {
  type: AddressType;
  street1?: string;
  street2?: string;
  city?: string;
  state?: string;
  zip: string;
  evidence: Evidence[];
}

export interface BorrowerIncome {
  source_type: IncomeSourceType;
  employer?: string;
  period_year: number;
  amount: number;
  currency: string;
  frequency?: IncomeFrequency;
  evidence: Evidence[];
}

export interface BorrowerIdentifier {
  type: IdentifierType;
  value: string;
  evidence: Evidence[];
}

export interface ApplicationLink {
  application_id: string;
  loan_number: string;
  role: PartyRole;
  evidence: Evidence[];
}

export interface DocumentRef {
  document_id: string;
  source_filename: string;
  raw_uri: string;
  correlation_id: string;
  processed_at: string;
}

export interface BorrowerRecord {
  schema_version: '1.1.0';
  borrower_id: string;
  borrower_key: string;
  status: BorrowerStatus;
  full_name: string;
  zip: string;
  addresses: BorrowerAddress[];
  income_history: BorrowerIncome[];
  identifiers: BorrowerIdentifier[];
  applications: ApplicationLink[];
  documents: DocumentRef[];
  last_correlation_id?: string;
  updated_at: string;
}

// ============================================================================
// Application Record (read model)
// ============================================================================

export interface ApplicationPartyRecord {
  borrower_id: string;
  full_name: string;
  role: PartyRole;
}

export interface ApplicationAddress {
  type: 'property';
  street1?: string;
  street2?: string;
  city?: string;
  state?: string;
  zip: string;
  evidence: Evidence[];
}

export interface ApplicationIdentifier {
  type: IdentifierType;
  value: string;
  evidence: Evidence[];
}

export interface ApplicationRecord {
  schema_version: '1.1.0';
  application_id: string;
  loan_number: string;
  property_address: ApplicationAddress;
  parties: ApplicationPartyRecord[];
  identifiers: ApplicationIdentifier[];
  documents: DocumentRef[];
  updated_at: string;
}

// ============================================================================
// API Types
// ============================================================================

export interface SyncRequest {
  source_system: string;
  since_cursor?: string | null;
  max_documents?: number;
}

export interface SyncResponse {
  correlation_id: string;
}

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    correlation_id: string;
  };
}

export interface BorrowerListResponse {
  items: BorrowerRecord[];
  next_cursor: string | null;
}

// ============================================================================
// External Source API Types
// ============================================================================

export interface ExternalDocumentItem {
  source_doc_id: string;
  filename: string;
  download_url: string;
  updated_at: string;
}

export interface ExternalDocumentListResponse {
  items: ExternalDocumentItem[];
  next_cursor: string | null;
}
