# Fixtures

This folder contains test fixtures used by the pipeline’s end-to-end and contract test suite.

## Layout

- `fixtures/corpus/`
  - Input PDFs used by tests (small, representative subset).
- `fixtures/expected/`
  - Golden JSON outputs used for snapshot-style assertions.
  - Every file in `fixtures/expected/` must validate against the schemas in `docs/contracts/`.

## Contracts

Tests validate fixture outputs against:

- `docs/contracts/extraction_result.schema.json`
- `docs/contracts/borrower_record.schema.json`
- `docs/contracts/application_record.schema.json`

## Pipeline entrypoint (event-driven)

The Adapter Service is the only component that **pulls** from external systems.
Fixtures simulate the same behavior by placing PDFs in `fixtures/corpus/` and triggering the adapter sync.

Downstream processing is **push/event-driven**:
- Adapter emits `document.available`
- workers process through extraction and persistence stages
- Query API reads persisted results from Postgres

### Adapter provenance fields

`ExtractionResult.document` MUST include:
- `source_system`
- `source_doc_id`

These fields come from the adapter list/download workflow and are required for end-to-end traceability.

## Snapshot strategy

The system is async and some fields are inherently non-deterministic. Snapshot tests:

1) **Normalize** ordering and formats (see below)  
2) **Strip** volatile fields (see below)  
3) Compare normalized JSON to the golden file in `fixtures/expected/`

## Volatile fields to strip before comparison

### ExtractionResult (`extraction_result.schema.json`)
Strip:
- `correlation_id`
- `extraction_metadata.request_id`
- `created_at`
- `document.raw_uri` (path differs by environment)

### BorrowerRecord (`borrower_record.schema.json`)
Strip:
- `borrower_id`
- `updated_at`
- `last_correlation_id`
- `documents[*].correlation_id`
- `documents[*].processed_at`
- `documents[*].raw_uri`

### ApplicationRecord (`application_record.schema.json`)
Strip:
- `application_id`
- `updated_at`
- `documents[*].correlation_id`
- `documents[*].processed_at`
- `documents[*].raw_uri`

## Normalization rules (stable ordering)

To avoid flaky snapshots, tests must sort arrays consistently.

### General rule
For every `evidence[]` array in any object:
- sort by `(document_id, page_number, quote)`

### ExtractionResult normalization
- sort `applications[]` by `loan_number.value`
- for each application:
  - sort `parties[]` by `(borrower_ref, role)`
  - sort `identifiers[]` by `(type, value)`
- sort `borrowers[]` by `(full_name.value, zip.value, borrower_ref)`
- for each borrower:
  - sort `addresses[]` by `(type, value.zip, value.street1, value.city, value.state)`
  - sort `income_history[]` by `(period.year, source_type, amount)`
  - sort `identifiers[]` by `(type, value)`
- sort top-level `missing_fields[]` lexicographically
- sort each borrower/application `missing_fields[]` lexicographically

### BorrowerRecord normalization
- sort `applications[]` by `(loan_number, role, application_id)`
- sort `addresses[]` by `(type, zip, street1, city, state)`
- sort `income_history[]` by `(period_year, source_type, amount)`
- sort `identifiers[]` by `(type, value)`
- sort `documents[]` by `(document_id, source_filename)`

### ApplicationRecord normalization
- sort `parties[]` by `(borrower_id, role, full_name)`
- sort `identifiers[]` by `(type, value)`
- sort `documents[]` by `(document_id, source_filename)`

## Updating golden outputs

When contracts or prompts change:

1. Update JSON Schemas under `docs/contracts/` (if required).
2. Run the pipeline on `fixtures/corpus/` (via `POST /sync` against the Adapter).
3. Normalize + strip volatile fields using the same logic as the tests.
4. Review diffs for:
   - value changes
   - completeness (`missing_fields`)
   - provenance quality (`evidence`)
5. Replace corresponding files under `fixtures/expected/`.
