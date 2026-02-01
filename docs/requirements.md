# Requirements

This document defines **scope** and **acceptance criteria** for the loan-document extraction system.
It is intentionally concise and is meant to be the primary anchor for implementation and tests.

---

## Scope

### Document set
- **Loan Documents** (PDFs with mixed formats)

### Core objective
Given a corpus of loan-related PDFs, the system MUST:
- extract structured data into **borrower (individual)** and **application (party-group / loan)** records
- persist results in Postgres
- expose a low-latency Query API for retrieval
- provide provenance for extracted values referencing the source document and page(s)

### Multi-party handling
- A single loan/application may include **multiple parties** (e.g., borrower + co-borrower).
- The system MUST represent this via an **ApplicationRecord** with `parties[]` and links back to individual **BorrowerRecords**.

### Integration model
- The **Adapter Service** is the only component that **pulls** from external systems.
- Everything downstream is **push/event-driven** via queues.

---

## Must-have requirements

### Adapter sync (pull)
- Provide an Adapter API endpoint:
  - `POST /sync`
- `POST /sync` MUST:
  1) call the external system to **list** new/changed documents
  2) **download** each document
  3) store the raw PDF into the object store (demo: shared filesystem volume)
  4) emit a `document.available` work item for downstream processing containing at least:
     - `correlation_id`
     - `document_id` (stable hash of PDF bytes)
     - `raw_uri`
     - `source_system`
     - `source_doc_id`
     - `source_filename`

### Ingestion + processing (push)
- Downstream workers MUST be queue-driven (no public HTTP surface required).
- Compute a stable `document_id` from PDF bytes (sha256 hex recommended).
- Run **text-first extraction**; if incomplete, run **PDF fallback extraction**.
- Produce an ExtractionResult that conforms to:
  - `docs/contracts/extraction_result.schema.json`

### Structured outputs
- Persist or upsert:
  - BorrowerRecord(s) conforming to `docs/contracts/borrower_record.schema.json`
  - ApplicationRecord(s) conforming to `docs/contracts/application_record.schema.json`
- Records MUST be linkable:
  - ApplicationRecord.parties[].borrower_id must reference a BorrowerRecord.borrower_id
  - BorrowerRecord.applications[] must include the linked application (loan_number + role)

### Retrieval interface (Query API)
- Implement the following endpoints:
  - `GET /borrowers/{borrower_id}`
  - `GET /borrowers?name=&zip=&status=&limit=&cursor=`
  - `GET /applications/by-loan/{loan_number}`
- Responses MUST conform to the JSON schemas under `docs/contracts/`.

### Provenance
Every extracted value MUST include evidence in the ExtractionResult:
- document id
- source filename
- page number
- short quote snippet

Persisted read models MUST also include evidence on:
- addresses
- income items
- identifiers
- application links
- property address
(Per the `evidence` fields in the schemas.)

### Partial results
- The pipeline MUST not fail the entire document if some fields cannot be extracted.
- When required fields are missing, the system MUST:
  - mark borrower status as `PARTIAL`
  - populate `missing_fields` in ExtractionResult and per-entity missing fields

### Observability
- Adapter API and Query API MUST expose Prometheus metrics at `GET /metrics`.
- Worker processes MUST expose Prometheus metrics at `GET /metrics` (separate port is acceptable).
- The system MUST propagate `correlation_id` through queues and logs.
- Minimal required metrics (the ones the load test will chart):
  - adapter sync runs per second (or per minute)
  - queue depth (per stage)
  - extraction latency (p50/p95) per stage
  - Query API latency (p50/p95)

### Reliability
- Queue-based processing with retries and dead-lettering MUST be implemented for worker stages.
- The system MUST support controlled failure injection in tests (e.g., force transient failures to validate retries).

---

## Nice-to-have (not required)

- More sophisticated address normalization beyond ZIP-only demo normalization
- Human review workflow / UI
- Vector search / embeddings
- Model fine-tuning
- Cost bounding (max pages / max file size) enforced in code

---

## Non-goals

- Building a front-end UI
- Perfect entity resolution across all possible PII variations
- Guaranteed real-time ingestion completion (processing is async by design)

---

## Acceptance criteria checklist

The submission is complete if:

- [ ] `POST /sync` pulls from external system (list + download) and enqueues `document.available`
- [ ] Adapter stores PDFs in the object store and emits work items with `document_id` and `raw_uri`
- [ ] Extraction runs text-first and optionally PDF fallback
- [ ] Extraction output validates against `extraction_result.schema.json`
- [ ] Borrower and application read models are persisted in Postgres
- [ ] Query endpoints return JSON validating against their schemas
- [ ] Multi-party loans are represented with `ApplicationRecord.parties[]`
- [ ] Borrower records link to associated loan numbers/applications
- [ ] Provenance is present for extracted values (document + page + quote)
- [ ] The system handles partial extractions without crashing
- [ ] Prometheus metrics are available and meaningful under load
- [ ] Tests validate schema conformance and snapshot fixtures
