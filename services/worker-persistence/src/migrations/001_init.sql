-- Initial database schema for loan document extraction system

-- ============================================================================
-- Core entities
-- ============================================================================

-- Borrowers table - individual people
CREATE TABLE IF NOT EXISTS borrowers (
    borrower_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    borrower_key VARCHAR(128) UNIQUE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PARTIAL' CHECK (status IN ('COMPLETE', 'PARTIAL')),
    full_name VARCHAR(255) NOT NULL,
    zip VARCHAR(10) NOT NULL,
    last_correlation_id VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_borrowers_status ON borrowers(status);
CREATE INDEX IF NOT EXISTS idx_borrowers_full_name ON borrowers(full_name);
CREATE INDEX IF NOT EXISTS idx_borrowers_zip ON borrowers(zip);

-- Applications table - loan applications (party groups)
CREATE TABLE IF NOT EXISTS applications (
    application_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    loan_number VARCHAR(64) UNIQUE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Documents table - source documents processed
CREATE TABLE IF NOT EXISTS documents (
    document_id VARCHAR(128) PRIMARY KEY,
    source_filename VARCHAR(512) NOT NULL,
    raw_uri VARCHAR(1024) NOT NULL,
    source_system VARCHAR(64) NOT NULL,
    source_doc_id VARCHAR(128) NOT NULL,
    correlation_id VARCHAR(64) NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(source_system, source_doc_id)
);

CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source_system, source_doc_id);

-- ============================================================================
-- Join tables
-- ============================================================================

-- Application parties - links borrowers to applications with role
CREATE TABLE IF NOT EXISTS application_parties (
    application_id UUID NOT NULL REFERENCES applications(application_id) ON DELETE CASCADE,
    borrower_id UUID NOT NULL REFERENCES borrowers(borrower_id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL CHECK (role IN ('borrower', 'co_borrower', 'other')),
    PRIMARY KEY (application_id, borrower_id)
);

CREATE INDEX IF NOT EXISTS idx_application_parties_borrower ON application_parties(borrower_id);

-- Borrower documents - links borrowers to source documents
CREATE TABLE IF NOT EXISTS borrower_documents (
    borrower_id UUID NOT NULL REFERENCES borrowers(borrower_id) ON DELETE CASCADE,
    document_id VARCHAR(128) NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
    PRIMARY KEY (borrower_id, document_id)
);

-- Application documents - links applications to source documents
CREATE TABLE IF NOT EXISTS application_documents (
    application_id UUID NOT NULL REFERENCES applications(application_id) ON DELETE CASCADE,
    document_id VARCHAR(128) NOT NULL REFERENCES documents(document_id) ON DELETE CASCADE,
    PRIMARY KEY (application_id, document_id)
);

-- ============================================================================
-- Borrower detail tables with evidence
-- ============================================================================

-- Borrower addresses
CREATE TABLE IF NOT EXISTS borrower_addresses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    borrower_id UUID NOT NULL REFERENCES borrowers(borrower_id) ON DELETE CASCADE,
    address_type VARCHAR(20) NOT NULL CHECK (address_type IN ('current', 'previous', 'mailing', 'property')),
    street1 VARCHAR(255),
    street2 VARCHAR(255),
    city VARCHAR(128),
    state CHAR(2),
    zip VARCHAR(10) NOT NULL,
    document_id VARCHAR(128) NOT NULL REFERENCES documents(document_id),
    page_number INTEGER NOT NULL,
    quote VARCHAR(300) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_borrower_addresses_borrower ON borrower_addresses(borrower_id);

-- Borrower income history
CREATE TABLE IF NOT EXISTS borrower_incomes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    borrower_id UUID NOT NULL REFERENCES borrowers(borrower_id) ON DELETE CASCADE,
    source_type VARCHAR(32) NOT NULL CHECK (source_type IN ('w2', 'paystub', 'tax_return_1040', 'schedule_c', 'bank_statement', 'other')),
    employer VARCHAR(255),
    period_year INTEGER NOT NULL,
    amount DECIMAL(15, 2) NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'USD',
    frequency VARCHAR(20) CHECK (frequency IN ('annual', 'monthly', 'biweekly', 'weekly', 'daily', 'unknown')),
    document_id VARCHAR(128) NOT NULL REFERENCES documents(document_id),
    page_number INTEGER NOT NULL,
    quote VARCHAR(300) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_borrower_incomes_borrower ON borrower_incomes(borrower_id);

-- Borrower identifiers (SSN, etc.)
CREATE TABLE IF NOT EXISTS borrower_identifiers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    borrower_id UUID NOT NULL REFERENCES borrowers(borrower_id) ON DELETE CASCADE,
    identifier_type VARCHAR(32) NOT NULL CHECK (identifier_type IN ('loan_number', 'account_number', 'ssn', 'ein', 'other')),
    identifier_value VARCHAR(128) NOT NULL,
    document_id VARCHAR(128) NOT NULL REFERENCES documents(document_id),
    page_number INTEGER NOT NULL,
    quote VARCHAR(300) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_borrower_identifiers_borrower ON borrower_identifiers(borrower_id);

-- ============================================================================
-- Application detail tables with evidence
-- ============================================================================

-- Application property address
CREATE TABLE IF NOT EXISTS application_addresses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id UUID NOT NULL REFERENCES applications(application_id) ON DELETE CASCADE,
    address_type VARCHAR(20) NOT NULL DEFAULT 'property' CHECK (address_type IN ('property')),
    street1 VARCHAR(255),
    street2 VARCHAR(255),
    city VARCHAR(128),
    state CHAR(2),
    zip VARCHAR(10) NOT NULL,
    document_id VARCHAR(128) NOT NULL REFERENCES documents(document_id),
    page_number INTEGER NOT NULL,
    quote VARCHAR(300) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_application_addresses_application ON application_addresses(application_id);

-- Application identifiers
CREATE TABLE IF NOT EXISTS application_identifiers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id UUID NOT NULL REFERENCES applications(application_id) ON DELETE CASCADE,
    identifier_type VARCHAR(32) NOT NULL CHECK (identifier_type IN ('loan_number', 'account_number', 'ssn', 'ein', 'other')),
    identifier_value VARCHAR(128) NOT NULL,
    document_id VARCHAR(128) NOT NULL REFERENCES documents(document_id),
    page_number INTEGER NOT NULL,
    quote VARCHAR(300) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_application_identifiers_application ON application_identifiers(application_id);

-- Application party evidence (for application_link in borrower record)
CREATE TABLE IF NOT EXISTS application_party_evidence (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id UUID NOT NULL REFERENCES applications(application_id) ON DELETE CASCADE,
    borrower_id UUID NOT NULL REFERENCES borrowers(borrower_id) ON DELETE CASCADE,
    document_id VARCHAR(128) NOT NULL REFERENCES documents(document_id),
    page_number INTEGER NOT NULL,
    quote VARCHAR(300) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_application_party_evidence_party ON application_party_evidence(application_id, borrower_id);
