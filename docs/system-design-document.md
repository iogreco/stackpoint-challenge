# Loan Document Extraction System — System Design Document

## 0. Setup and local validation

Run the system end-to-end via Docker Compose, validate extraction correctness via E2E tests, and validate scaling behavior via a k6 load test with Prometheus scraping a minimal dashboard (queue depth, throughput, error rate, and end-to-end latency).

### 0.1 Start the system (dev)

```bash
docker compose up -d
```

Local ports:
- Adapter API: `http://localhost:8080`
- Query API: `http://localhost:8081`
- Postgres: `localhost:5432`
- Redis: `localhost:6379`

### 0.2 Run E2E integration tests

```bash
make test-e2e
```

This runs black-box tests against an isolated compose stack with fresh volumes.

### 0.3 Run load test with observability

```bash
make obs-setup
Grafana: http://localhost:3004 (admin/admin)
make obs-load
make obs-cleanup
```

The load test targets **adapter sync** and uses a small set of fixture PDFs repeatedly (no disk growth beyond a bounded object-store directory; see §6.3).

---

### 0.4 Specification artifacts

This repository is implemented against a small set of concrete, machine-checkable artifacts:

- **API contract:** `docs/api.md`
- **Data contracts (JSON Schema):**
  - `docs/contracts/extraction_result.schema.json` (LLM output per document; includes per-field evidence + completeness flags)
  - `docs/contracts/borrower_record.schema.json` (BorrowerRecord read model served by the Query API)
  - `docs/contracts/application_record.schema.json` (ApplicationRecord read model linking **multiple parties** under a loan number)
- **Test fixtures (golden outputs):**
  - `fixtures/expected/*.json`
  - `fixtures/README.md` (snapshot rules: volatile-field stripping + stable ordering required for deterministic tests)


## 1. Overview

### 1.1 Problem statement

Given a corpus of heterogeneous **loan documents** (PDFs with varying formats), build a system that:

- extracts borrower PII (**name, address**) and financials (**income history**),
- associates extracted data with **account / loan numbers** when present,
- produces structured read models with **clear provenance** back to source documents,
- supports **multi-party** loans by emitting individual BorrowerRecords and an ApplicationRecord (party-group) keyed by loan number when available,
- exposes a basic **query API** to retrieve borrower records and (when present) application records.

### 1.2 Design goals

1. **Pipeline robustness:** asynchronous, queue-backed processing resilient to bursts and partial failures.
2. **Format variability tolerance:** text-first extraction with a PDF+vision fallback.
3. **Operational clarity:** metrics/logs/tracing to explain queue depth, retries, throughput.
4. **Scalable shape:** worker horizontal scaling and explicit backpressure controls.
5. **Local operability:** runnable locally via Docker Compose with a load test harness.
6. **Multi-party + provenance:** represent borrowers as individuals, link them under loan applications when present, and preserve per-field evidence.

### 1.3 Non-goals

- Perfect entity resolution across a massive population (this implementation uses a simplified borrower matching key).
- Full KYC-grade address normalization (this implementation uses zip-based simplification; production uses a full address normalization service).
- Sophisticated human-in-the-loop review tooling (we provide hooks / flags).

---


### 1.4 Technical stack

| Layer | Technology |
|-------|------------|
| **Runtime** | Node.js 18+ |
| **Language** | TypeScript |
| **Web framework** | Express |
| **Containerization** | Docker |
| **Orchestration** | Docker Compose |
| **Database** | PostgreSQL 15 |
| **Queue** | Redis 7 + BullMQ |
| **Object storage** | Local filesystem (`object-store/`); production: S3/GCS |
| **Observability** | Prometheus, Grafana, k6 |
| **Build / tests** | Makefile, Jest |

All application services (Adapter API, Query API, workers) are Node.js/TypeScript processes, each with a Dockerfile and `package.json`. The system runs via `docker compose up -d`; E2E and load tests use isolated compose stacks as described in §0.


## 2. Architecture overview

### 2.1 Components

**Adapter API (pull integration boundary)**
- Exposes `POST /sync` to trigger a sync pass against an external system.
- Integrates with external systems via an Adapter implementation (HTTP list + download in this demo).
- Generates a **`correlation_id`** per sync request for end-to-end traceability.
- Computes a stable **`document_id`** (content hash) for dedupe and idempotent storage.
- Stores raw PDFs in the object store abstraction (local filesystem object store).
- Enqueues `document_available` work items to begin asynchronous processing.

**External Source API (mock fixture source)**
- Represents a source system with two endpoints: list available documents and download document bytes.
- Used for local validation and load testing to replay a small fixture corpus without the load generator managing large files.

**Ingestion Worker**
- Consumes `document_available` jobs.
- Validates the stored PDF reference, registers minimal metadata, and emits `extract_text`.

**Text Extractor Worker (text-first)**
- Consumes `extract_text` jobs.
- Extracts page-bounded plain text from the PDF.
- Calls the LLM with **text-only** input under a schema-constrained contract.
- Validates completeness. If required fields are missing, enqueues `extract_pdf` for fallback; otherwise emits `persist_records`.

**PDF Fallback Extractor Worker (multimodal)**
- Consumes `extract_pdf` jobs.
- Calls the LLM with the **full PDF** to leverage layout/vision understanding when text-only is insufficient.
- Produces a best-effort extraction (complete or partial) and emits `persist_records`.

**Persistence Worker**
- Consumes `persist_records` jobs.
- Upserts **BorrowerRecord** and **ApplicationRecord** read models into Postgres.
- Persists provenance (page-level `evidence`) and completeness status (`COMPLETE` / `PARTIAL`).

**Query API**
- Serves borrower/application read models from Postgres with low latency.
- Isolated from ingestion/extraction load (separate process, separate scaling profile).

**Postgres**
- System of record for read models.

**Redis/BullMQ**
- Durable stage queues (`document_available`, `extract_text`, `extract_pdf`, `persist_records`) and backpressure.

**Prometheus/Grafana**
- Minimal observability stack for metrics and load-test validation.

### 2.2 Component diagram

```text
                             ┌───────────────────────────────┐
                             │ External Source System (mock) │
                             │ - GET /documents (list)       │
                             │ - GET /documents/{id} (bytes) │
                             └───────────────┬───────────────┘
                                             │ (pull: list + download)
                                             ▼
┌───────────────────┐          ┌──────────────────────────┐          ┌───────────────────────────┐
│ Clients / LoadGen │─────────►│ Adapter API              │─────────►│ Ingestion Worker          │
│ (triggers sync)   │  POST    │ - POST /sync             │  emits   │ - validates raw_uri       │
└───────────────────┘  /sync   │ - store raw PDFs         │  work    │ - emits extract_text      │
                               │ - emit document_available│  items   └─────────────┬─────────────┘
                               └─────────────┬────────────┘                        │
                                             │                                     │
                                             │                                     ▼
                                             │                       ┌───────────────────────────┐
                                             │                       │ Extraction Workers        │
                                             │                       │ - text-first              │
                                             │                       │ - PDF fallback (if needed)│
                                             │                       └────────────┬──────────────┘
                                             │                                    │
                                             │                                    ▼
                                             │                       ┌───────────────────────────┐
                                             │                       │ LLM Provider              │
                                             │                       │ - schema extraction       │
                                             │                       └───────────────────────────┘
                                             │
                                             ▼
                               ┌──────────────────────────┐
                               │ Persistence Worker       │
                               │ - upsert read models     │
                               │ - attach provenance      │
                               └─────────────┬────────────┘
                                             │
                                             ▼
                               ┌──────────────────────────┐
                               │ Postgres                 │
                               │ - borrowers              │
                               │ - applications           │
                               └─────────────┬────────────┘
                                             ▲
                                             │
                               ┌─────────────┴────────────┐
                               │ Query API                │
                               │ - search borrowers       │
                               │ - get by loan_number     │
                               └─────────────┬────────────┘
                                             ▲
                                             │
                                        ┌────┴────┐
                                        │ Clients │
                                        └─────────┘
```

### 2.3 Runtime view

In the reference implementation, service boundaries are connected via durable queues and a simple object store:

- **BullMQ** provides stage queues (`document_available`, `extract_text`, `extract_pdf`, `persist_records`) and backpressure; **Redis** is the durable backing store.
- A local **object store directory** holds raw PDFs keyed by `document_id` (content hash). The Adapter writes to this store; downstream workers read from it.
- **Postgres** stores the read models served by the Query API.
- The Query API is isolated from ingestion/extraction load (separate process, separate scaling profile).

The Adapter is the only component that performs **pull** integrations. Downstream processing is **push/event-driven**: each worker consumes from a queue, performs a deterministic unit of work, and emits the next message.

## 3. Data pipeline design

### 3.1 Adapter pull and document availability

**Entry point**
- `POST /sync` on the **Adapter API** (see `docs/api.md`)

**External integration (HTTP in this demo)**
- `GET /documents?since_cursor=...` (list)
- `GET /documents/{source_doc_id}` (download PDF bytes)

**Steps**
1. Receive `POST /sync` and generate a **correlation_id** (ULID/UUID) for end-to-end tracing.
2. Call the external system to list documents (bounded by `max_documents`).
3. For each listed document:
   - download PDF bytes,
   - compute `document_id = sha256(pdf_bytes)` (content-addressed),
   - store to object store at `object-store/raw/{source_system}/{document_id}.pdf` (idempotent overwrite),
   - enqueue a `document_available` message:
     - `correlation_id`, `document_id`, `raw_uri`, `source_system`, `source_doc_id`, `source_filename`, `discovered_at`.
4. Return `202 Accepted` with `correlation_id` immediately after scheduling/enqueuing.

**Notes**
- The Adapter is the only component that **pulls** from external systems. Everything downstream is **push/event-driven** via queues.
- Replays do not grow disk: the object-store path is deterministic by `document_id`, so repeated syncs overwrite/reuse the same file.

### 3.2 Stage 1: Text-first extraction (Text Extractor Worker)

1. Extract plain text per-page using a local PDF parser (e.g., `pdfplumber` / `pdfjs`).
2. Run LLM extraction on **text only** and produce an `ExtractionResult` that conforms to `docs/contracts/extraction_result.schema.json`:
   - Borrower identity fields
   - Loan/account numbers
   - Income events (W-2, VOI/EVOE, paystub, Schedule C, etc.)
   - Provenance pointers (doc + page + excerpt)
3. Validate response against schema + run lightweight consistency checks (see §8).
4. Determine completeness:
   - If all required fields satisfied → enqueue `persist_borrower`.
   - Else → enqueue `extract_pdf` (stage 2), passing partial extraction + missing-fields list.
   - If stage 2 is disabled/unavailable → enqueue `persist_borrower` with `completeness_status=partial`.

### 3.3 Stage 2: PDF fallback extraction (PDF Fallback Extractor Worker)

1. Send **the PDF file** to the provider’s PDF input feature, requesting only missing fields and evidence.
2. Merge: `merged = deepMerge(stage1, stage2)` with “stage2 only fills null/unknown” semantics.
3. Re-validate schema and consistency.
4. Enqueue `persist_borrower`.

### 3.4 Persistence (Persistence Worker)

The persistence stage turns an `ExtractionResult` into durable read models.

1. **Borrower matching**
   - For each extracted borrower, compute a deterministic match key:
     - `borrower_key = sha256(normalize(full_name) + "|" + normalize(zip))`
   - This demo uses ZIP as the address join key (see §6). Production systems use full postal normalization and stronger identity resolution.

2. **Application / party-group handling (multi-party)**
   - If a **loan number** is present in the extraction payload, upsert an **Application** entity keyed by `loan_number`.
   - Link all extracted parties to the application via `(application_id, borrower_id, role)` where role ∈ {borrower, co_borrower, other}.
   - If a loan number is not present, no ApplicationRecord is created; the system still persists BorrowerRecords and their identifiers (e.g., account numbers).

3. **Transactional upsert (idempotent)**
   - In a single DB transaction:
     - upsert `borrowers` (one per borrower_key)
     - upsert `applications` (when loan number present)
     - upsert join rows `application_parties`
     - upsert `borrower_incomes` (keyed by `(borrower_id, period_year, source_type, document_id)`)
     - upsert `borrower_identifiers` (keyed by `(borrower_id, type, value, document_id)`)
     - upsert `documents` (keyed by `document_id`) and attach document references to borrower/application records
     - persist **evidence** rows (page + quote) for each extracted field/value
   - Reprocessing the same PDF (same `document_id`) is safe: the transaction is idempotent and evidence is de-duplicated on stable keys.

4. Emit success/error metrics and structured logs.


### 3.5 Retrieval (Query API)

The **Query API** serves low-latency read queries. The canonical endpoints and example responses are defined in `docs/api.md`:

- `GET /borrowers/{borrower_id}`
- `GET /borrowers?name=...&zip=...&status=...&limit=...&cursor=...`
- `GET /borrowers/by-loan/{loan_number}` (optional)

---

## 4. Structured outputs (read models)

The system persists normalized tables in Postgres and serves **read models** through the Query API. The concrete JSON shapes are defined in `docs/contracts/`.

### 4.1 BorrowerRecord (individual)

Each **BorrowerRecord** represents a single person (borrower / co-borrower / other party). Borrowers are merged across documents using `borrower_key` (name + ZIP) and preserve evidence for extracted values.

Conforms to: `docs/contracts/borrower_record.schema.json`.

```json
{
  "schema_version": "1.1.0",
  "borrower_id": "11111111-1111-1111-1111-111111111111",
  "borrower_key": "sha256(normalized_full_name|zip)",
  "status": "COMPLETE",
  "full_name": "John Homeowner",
  "zip": "20013",
  "addresses": [
    {
      "type": "current",
      "street1": "175 13th Street",
      "city": "Washington",
      "state": "DC",
      "zip": "20013",
      "evidence": [
        { "document_id": "…", "source_filename": "Paystub- John Homeowner (Current).pdf", "page_number": 1, "quote": "…Washington, DC 20013" }
      ]
    }
  ],
  "income_history": [
    {
      "source_type": "w2",
      "employer": "ABC Technologies",
      "period_year": 2024,
      "amount": 117040.19,
      "currency": "USD",
      "frequency": "annual",
      "evidence": [
        { "document_id": "…", "source_filename": "W2 2024- John Homeowner.pdf", "page_number": 1, "quote": "…117040.19…" }
      ]
    }
  ],
  "identifiers": [
    {
      "type": "account_number",
      "value": "…1234",
      "evidence": [
        { "document_id": "…", "source_filename": "Checking - John Mary Homeowner (Current).pdf", "page_number": 1, "quote": "Account Number …1234" }
      ]
    }
  ],
  "applications": [
    {
      "application_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "loan_number": "TEST250700110",
      "role": "borrower",
      "evidence": [
        { "document_id": "…", "source_filename": "Closing_Disclosure.pdf", "page_number": 1, "quote": "Loan ID #: TEST250700110" }
      ]
    }
  ],
  "documents": [
    {
      "document_id": "…",
      "source_filename": "Closing_Disclosure.pdf",
      "raw_uri": "file://storage/raw/…",
      "correlation_id": "…",
      "processed_at": "2026-01-31T00:00:00Z"
    }
  ],
  "last_correlation_id": "…",
  "updated_at": "2026-01-31T00:00:00Z"
}
```

### 4.2 ApplicationRecord (loan party-group)

Loan documents can list **multiple parties** (e.g., borrower + co-borrower). When a loan number is present, the system creates an **ApplicationRecord** keyed by that loan number and links parties with roles.

Conforms to: `docs/contracts/application_record.schema.json`.

```json
{
  "schema_version": "1.1.0",
  "application_id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  "loan_number": "TEST250700110",
  "property_address": {
    "type": "property",
    "street1": "175 13th Street",
    "city": "Washington",
    "state": "DC",
    "zip": "20013",
    "evidence": [
      { "document_id": "…", "source_filename": "Closing_Disclosure.pdf", "page_number": 1, "quote": "…Washington, DC 20013" }
    ]
  },
  "parties": [
    { "borrower_id": "11111111-1111-1111-1111-111111111111", "full_name": "John Homeowner", "role": "borrower" },
    { "borrower_id": "22222222-2222-2222-2222-222222222222", "full_name": "Mary Homeowner", "role": "co_borrower" }
  ],
  "identifiers": [
    {
      "type": "loan_number",
      "value": "TEST250700110",
      "evidence": [
        { "document_id": "…", "source_filename": "Closing_Disclosure.pdf", "page_number": 1, "quote": "Loan ID #: TEST250700110" }
      ]
    }
  ],
  "documents": [
    {
      "document_id": "…",
      "source_filename": "Closing_Disclosure.pdf",
      "raw_uri": "file://storage/raw/…",
      "correlation_id": "…",
      "processed_at": "2026-01-31T00:00:00Z"
    }
  ],
  "updated_at": "2026-01-31T00:00:00Z"
}
```

### 4.3 Provenance model (evidence)

Every extracted value includes an `evidence[]` list:

- `document_id` (stable hash of the PDF bytes)
- `source_filename` (original filename)
- `page_number` (1-indexed)
- `quote` (short snippet anchoring the value; bounded length for storage/logging)

This is sufficient to satisfy the requirement “clear reference to the original document(s) from which the information was sourced.” Production systems can add bounding boxes for UI highlighting, but they are not required for this assignment.


## 5. AI/LLM integration strategy

### 5.1 Model selection and routing

**Stage 1 (text-only):** fast/cheap model for structured extraction
- Emphasis: schema compliance + speed.
- Input: per-page text chunks with page numbers.

**Stage 2 (PDF input):** vision-capable model with PDF support
- Used only when Stage 1 returns incomplete/low-confidence results.
- Input: the PDF file plus a “missing fields” directive and strict output schema.

### 5.2 Prompting and schema enforcement

- Use JSON-schema constrained output (or provider-native structured output).
- Enforce post-LLM validation:
  - parse JSON
  - validate schema
  - reject/repair on failure (see §8.2).

### 5.3 Cost-awareness (without implementing hard bounds)

The pipeline defaults to text-only extraction and escalates to PDF+vision only when required fields are missing. Hard caps (max pages, max size) are not implemented here; they are applied at the Adapter API and extractor boundaries in production.

---

## 6. Handling document format variability

### 6.1 Common variability patterns

- PDFs with selectable text but inconsistent layout (tables, multi-column, headers/footers).
- PDFs where key values appear in non-obvious labels (“tracking number”, “reference number”, etc.).
- “Structured-ish” documents (tax forms) where totals can be inferred only if you understand the form.

### 6.2 Practical mitigations

- Page-aware text extraction (preserve page boundaries).
- Minimal cleanup:
  - remove repeated headers/footers if obvious
  - normalize whitespace
- A small pre-classifier step (LLM or heuristic) to label doc type:
  - W2 / paystub / verification / bank statement / tax form / closing disclosure / title report.
  - Used to route extraction templates.

### 6.3 Reprocessing without disk growth

Because raw PDFs are stored content-addressed (`document_id = sha256(bytes)`), re-ingesting the same fixtures does not create unbounded growth in `object-store/`. Multiple ingestions of the same document produce different `correlation_id`s but point to the same `document_id`.

---

## 7. Orchestration & resilience patterns

This system is internally **event-driven**. The Adapter emits work items, and downstream workers coordinate via stage queues. Resilience behavior is controlled by environment variables (see **Appendix B**) and validated via controlled failure tests (see **§12.4** and **Appendix C**).

### 7.1 Message queue semantics (BullMQ)

This implementation uses **BullMQ** as the queue/orchestration library backed by **Redis** as the persistence layer.

BullMQ provides:
- request buffering between stages
- natural backpressure via queue depth and worker concurrency
- retry handling with exponential backoff and jitter
- dead-lettering / failure isolation via a failed-jobs queue (DLQ pattern)

**Redis persistence:** BullMQ stores job state in Redis. To ensure durability across container restarts, Redis SHOULD be configured with persistence enabled:
- **AOF (Append-Only File)** is recommended for stronger durability guarantees, or
- **RDB snapshotting** as a lighter-weight alternative.

**Ack/Nack behavior:** BullMQ implicitly **acknowledges** a job when the worker function completes successfully. A worker that **throws** (or returns a rejected promise) implicitly **nacks** the job, triggering BullMQ’s retry logic according to the job configuration (attempts, backoff, jitter).

### 7.2 Stage queues and handoff contracts

The pipeline uses dedicated BullMQ queues per stage:

- `document_available` — emitted by the Adapter after a successful list+download and raw-PDF write
- `extract_text` — text-first extraction worker
- `extract_pdf` — PDF fallback extraction worker
- `persist_records` — upsert borrower/application read models into Postgres

Each job payload MUST include:

#### Example: `document.available` job payload

The Adapter emits a `document.available` event and enqueues it onto the BullMQ queue named `document_available`.

```json
{
  "event_type": "document.available",
  "correlation_id": "01J4Z0D0Q9QW4B7Y6K8J2H3R1M",
  "document_id": "sha256:4e9f6c6b2b6f7b2e5f3d0a8f0c8b2b4b7b9e3a1c6d2e1f0a9b8c7d6e5f4a3b2c",
  "raw_uri": "file://object-store/raw/fixture_source/4e9f6c6b2b6f7b2e5f3d0a8f0c8b2b4b7b9e3a1c6d2e1f0a9b8c7d6e5f4a3b2c.pdf",
  "source_system": "fixture_source",
  "source_doc_id": "doc_001",
  "source_filename": "Closing_Disclosure.pdf",
  "discovered_at": "2026-01-31T22:00:00Z"
}
```

- `correlation_id` (unique per processing attempt)
- `document_id` (stable content hash; used for dedupe/idempotency)
- `raw_uri`
- `source_system`
- `source_doc_id`
- `source_filename`

Downstream workers propagate these values into `ExtractionResult.document` for provenance and traceability.

### 7.3 Backpressure and input control

Backpressure is governed by configuration parameters (Appendix B):

- `WORKER_CONCURRENCY_*` controls how many jobs may run simultaneously per stage. Increasing concurrency raises throughput but also increases pressure on dependencies (LLM provider and Postgres).
- `MAX_QUEUE_DEPTH_WARNING` defines when the system should emit warnings due to backlog growth.
- `MAX_QUEUE_DEPTH_REJECT` defines when the Adapter should temporarily reject new `POST /sync` requests to prevent unbounded accumulation.

Operationally:
- queue depth buffers spikes
- worker concurrency protects downstream dependencies
- adapter input control protects the system from overload

### 7.4 Retries, backoff, and DLQ

Each stage uses bounded retries with exponential backoff and jitter:
- transient failures are retried (e.g., timeouts, rate limits, transient DB errors)
- repeated failures route the job to a DLQ/failed-jobs queue and increment failure metrics

### 7.5 External dependency protection

- **External source (Adapter):** per-host rate limiting, bounded download concurrency, and (optional) circuit breaker to avoid hammering an unhealthy source.
- **LLM provider:** global concurrency cap and request timeouts to prevent runaway cost/latency.
- **Postgres:** bounded connection pool; persistence worker retries on transient errors.

### 7.6 Idempotency, ordering, and correlation ID propagation

- **Correlation ID:** generated per `POST /sync` request and propagated through every job payload. Use `AsyncLocalStorage` to bind `correlation_id` to logs emitted during job execution (so logs remain traceable without manual plumbing in every call site).
- **Document ID:** derived from bytes (`sha256(pdf_bytes)`) and used for dedupe and safe reprocessing. It is stable across runs and distinct from `correlation_id`.
- **Idempotent writes:** persistence uses upserts keyed by stable identifiers (e.g., borrower_id + application/loan keys) to make repeated processing safe.
- **Ordering:** strict ordering is not required for this prototype; if needed, BullMQ can serialize per-key (e.g., per loan_number) using queue partitioning or per-entity locks.



## 8. Error handling and data quality validation

### 8.1 Error taxonomy

- **Input validation errors** (400): not a PDF, too large, missing payload.
- **Transient external errors** (retry): LLM rate limit, network timeouts, Postgres connection pool exhaustion.
- **Permanent extraction errors** (DLQ): unreadable PDF, repeated schema violations.

### 8.2 Data quality checks

After each extraction:
- required fields present? (name + zip at minimum)
- numeric sanity: amounts >= 0, years plausible
- cross-field checks:
  - if income_type is W2, employer should exist
  - if Schedule C, net profit should exist

Outputs are tagged:
- `completeness=complete|partial`
- `warnings=[...]`
- `missing_fields=[...]`

---

## 9. Basic query / retrieval interface (Query API)

### 9.1 Endpoints

Endpoints are defined in `docs/api.md`. The Query API exposes:

- `GET /borrowers/{borrower_id}`
- `GET /borrowers?name=...&zip=...&status=...&limit=...&cursor=...`
- `GET /applications/by-loan/{loan_number}`
- `GET /health` and `GET /metrics`


### 9.2 Why separate the Query API from ingestion workers?

Workloads differ:
- ingest pipeline is bursty, throughput-oriented, latency-tolerant
- query API is latency-sensitive and should not degrade under ingest spikes

Isolation allows independent autoscaling and resource limits.

---

## 10. Observability & logging

### 10.1 Metrics (Prometheus)

All services expose a `/metrics` endpoint. Prometheus scrapes these endpoints and Grafana renders a minimal operational view.

**Metrics emitted**
- `queue_jobs_waiting{queue}`: current queue depth for `extract_text`, `extract_pdf`, `persist_borrower`
- `jobs_processed_total{queue, outcome}`: processed jobs counter (`success` / `failed` / `dlq`)
- `job_attempts_total{queue}`: total attempts (includes retries)
- `stage_duration_seconds_bucket{stage}`: histogram per stage (`extract_text`, `extract_pdf`, `persist_borrower`)
- `end_to_end_latency_seconds_bucket`: histogram from ingest acceptance to successful persist

These metrics are sufficient to validate backpressure behavior, throughput, and stability under load.
### 10.2 Structured logs

All services emit JSON logs containing (the `correlation_id` and `document_id` fields are injected automatically via `AsyncLocalStorage`):
- `correlation_id`, `document_id`, `borrower_id` (if known)
- `stage` (`ingest`, `extract_text`, `extract_pdf`, `persist`, `query`)
- errors include `error_class`, `retryable`, `attempt`

### 10.3 Tracing

Correlation_id-based log stitching is sufficient. Production systems add OpenTelemetry spans around each stage.

### 10.4 Debugging pipeline runs

The system does not implement a “job status” endpoint. Operational debugging is performed via:

1. **Correlation ID log stitching:** the Adapter API returns (and logs) `correlation_id`; all downstream workers include it automatically via `AsyncLocalStorage`.
2. **Queue inspection:** BullMQ/Redis exposes job state (`waiting`, `active`, `delayed`, `failed`). Failed jobs ultimately land in the DLQ with a reason code.
3. **Dashboards:** queue depth, retry counters, stage throughput, and LLM/provider error rates explain whether the system is backlogged, throttled, or failing fast.

This keeps the runtime surface area small while preserving debuggability.

---

## 11. Scaling considerations (10x and 100x)

### 11.1 10x volume (single-region)

- Scale worker replicas horizontally:
  - more `extract_text` workers first
  - then `persist` workers
  - keep `extract_pdf` workers smaller (only triggered on misses)
- Move object store to managed S3/GCS.
- Postgres: increase connection pool, add read replica for the Query API.

### 11.2 100x volume

- Queue: move from Redis/BullMQ to a managed queue/event bus:
  - e.g., SQS + Lambda/ECS workers, or Kafka/NATS if event streaming is required.
- Database:
  - partition by borrower_id
  - separate “hot” borrower table from “cold” document/provenance tables
  - add a search index (OpenSearch/Elastic) for name/loan lookups if required
- LLM:
  - batching and request coalescing
  - aggressive “text-only first” + page-windowing
  - provider quota management and multi-provider failover

### 11.3 Failure modes at scale

- LLM outage → extraction backlog increases; backpressure protects the system.
- Postgres outage → persist jobs retry with backoff; query API degrades gracefully (read-only).

---

## 12. Testing strategy (critical paths)

### 12.1 Unit tests

- PDF text extraction on representative fixtures (source files under `fixtures/`, golden outputs under `fixtures/expected/`)
- schema validation + merge logic
- borrower_key normalization and idempotent upsert behavior

### 12.2 Integration/E2E tests

Run via `make test-e2e` (asserts against `fixtures/expected/*.json`, normalized per `fixtures/README.md`):

- ingest a fixture document
- wait for pipeline completion
- query borrower record(s) and assert:
  - required fields present (or correctly flagged as missing)
  - `evidence[]` entries exist for extracted values
- if the fixture contains a loan number:
  - query `GET /applications/by-loan/{loan_number}` and assert parties and provenance are present



### 12.3 Load test design

The load test validates that the pipeline remains stable under burst sync requests and that backpressure, retries, and worker concurrency controls behave as designed.

**Mechanics**
- A small fixture corpus (e.g., 5–10 PDFs) is served by the **Fixture Source Service** (External Source API).
- The k6 load generator repeatedly calls `POST /sync` on the **Adapter API** using the request shape defined in `docs/api.md`.
- The Adapter pulls (list + download), stores raw PDFs under `document_id` (content hash), and enqueues downstream work. Replays reuse the same object-store path while each sync request receives a fresh `correlation_id`.

**Scenarios**
1. **Warm-up (steady)**: constant sync rate to establish baseline throughput.
2. **Burst**: short high-rate spike intended to grow queue depth and (if configured) trigger backpressure at the Adapter API.
3. **Recovery**: load drops back to baseline (or zero) and the system drains queues back to steady-state.

**Execution**
```bash
make obs-setup
make obs-load   # runs k6 against the Adapter API
make obs-cleanup
```

**Success criteria**
- The Adapter API maintains bounded latency until backpressure engages; once engaged it returns `503` quickly (fail-fast) rather than timing out.
- Queue depth increases during the burst and returns to baseline during recovery.
- Retries occur only for retryable failures; non-retryable failures route to DLQ.
- The Query API remains responsive during the entire test.

**Dashboards (minimal)**
The Grafana dashboard contains four panels:
1. **Queue depth** by queue: `document_available`, `extract_text`, `extract_pdf`, `persist_records`
2. **Worker throughput** (documents/sec) per stage
3. **Failures & retries**: failed jobs, retry attempts, DLQ count
4. **End-to-end processing latency**: time from `document_available` enqueued → Postgres upsert (p50/p95)
### 12.4 Controlled Failure Injection Specification

Controlled failure injection is part of the **test strategy** for validating retries, backoff, DLQ routing, and backpressure without relying on flaky external dependencies.

**Principles**
- **Opt-in only:** disabled by default; enabled only when `ENABLE_CONTROLLED_FAILURES=true` (e.g., CI, `loadtest` compose profile).
- **Fail-once semantics:** inject a failure only on the **first attempt** for a given job, so the retry behavior is deterministic and observable.
- **Targeted failpoints:** choose the stage to fail without crashing containers.

**Failpoints**
- `FAILPOINT_LLM_TEXT`: throw a synthetic retryable error immediately before the text-only LLM request.
- `FAILPOINT_LLM_PDF`: throw a synthetic retryable error immediately before the PDF fallback LLM request.
- `FAILPOINT_PERSIST`: throw a synthetic retryable error immediately before the DB transaction/commit.

**How tests use it**
- E2E/load tests set a header on sync (propagated into the job payload) or an env var to activate a specific failpoint.
- Assertions:
  - the job retries exactly once (or up to `MAX_JOB_ATTEMPTS` when configured),
  - retry/backoff metrics increment,
  - successful completion occurs on the next attempt (fail-once mode),
  - DLQ is populated when failures are configured to persist beyond attempts.


## 13. Key trade-offs & reasoning

- **Redis/BullMQ vs Kafka:** BullMQ is lightweight and sufficient for this implementation; the design explicitly notes the migration path for 100x.
- **No intermediate persistence:** queues are the “in-flight” state; Postgres is the system of record. This minimizes complexity while preserving the core reliability story.
- **Text-first + PDF fallback:** cost-aware and robust without prematurely optimizing via page rasterization.
- **Separate query API:** isolates latency-sensitive reads from ingest spikes.

---

## Appendix A: Potential enhancements

- Human review queue + UI for partial/low-confidence records
- Better borrower matching (full address normalization, fuzzy match, SSN handling)
- Bounding box provenance (requires PDF layout extraction)
- Materialized “borrower view” table for query performance
- Document type classifier and specialized extraction templates per doc type

## Appendix B: Global configuration parameters

These parameters are intentionally environment-variable driven so throughput and resilience behavior can be tuned without code changes.

### Adapter

- `ADAPTER_POLL_CONCURRENCY` — max concurrent downloads in a single sync pass
- `ADAPTER_RATE_LIMIT_RPS` — outbound request cap to the external system
- `SYNC_MAX_DOCUMENTS` — safety cap for one `POST /sync` run

### BullMQ / workers

- `WORKER_CONCURRENCY_DOCUMENT_AVAILABLE`
- `WORKER_CONCURRENCY_EXTRACT_TEXT`
- `WORKER_CONCURRENCY_EXTRACT_PDF`
- `WORKER_CONCURRENCY_PERSIST_RECORDS`

- `BULLMQ_DEFAULT_ATTEMPTS`
- `BULLMQ_BACKOFF_BASE_MS`
- `BULLMQ_BACKOFF_JITTER_MS`
- `BULLMQ_JOB_TIMEOUT_MS`

- `MAX_QUEUE_DEPTH_WARNING`
- `MAX_QUEUE_DEPTH_REJECT`

### Data store

- `PG_MAX_POOL_SIZE`
- `PG_STATEMENT_TIMEOUT_MS`

### LLM

- `LLM_MODEL_TEXT`
- `LLM_MODEL_PDF`
- `LLM_REQUEST_TIMEOUT_MS`
- `LLM_MAX_CONCURRENCY` (optional global limiter)


## Appendix C: Controlled failure injection

The test suite includes controlled failures to validate retry semantics, DLQ behavior, and correlation-id propagation.

Examples (implemented via env toggles or test hooks):

- `FAIL_ADAPTER_LIST_PERCENT=0..100` — randomly fail external list calls
- `FAIL_ADAPTER_DOWNLOAD_PERCENT=0..100` — randomly fail external downloads
- `FAIL_LLM_TEXT_PERCENT=0..100` — randomly fail text extraction calls
- `FAIL_LLM_PDF_PERCENT=0..100` — randomly fail PDF fallback calls
- `FAIL_PERSIST_PERCENT=0..100` — randomly fail Postgres upserts

Expected behavior:
- failures trigger BullMQ nack semantics (throw -> retry)
- retries follow exponential backoff + jitter
- repeated failure routes the job to DLQ and increments failure metrics
- logs include `correlation_id` for traceability

