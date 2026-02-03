# Loan Document Extraction System

An event-driven document extraction pipeline that extracts borrower PII, income history, and loan data from PDFs using LLM-based extraction with provenance tracking.

---

## Setup and run instructions

### Prerequisites

- Docker and Docker Compose
- Node.js 18+
- OpenAI API key (for LLM extraction)

### Setup

```bash
# Install dependencies (and build shared package via prepare script)
make install

# Set OpenAI API key
export OPENAI_API_KEY=your-api-key-here

# Build images and start all services
make build
make up

# View logs
make logs
```

### Verify services

```bash
# Health checks
make health

# Trigger a document sync
make sync

# Wait a few seconds for the pipeline to process documents, then list borrowers
make borrowers
```

### Run E2E integration tests

- **Without OpenAI** (pipeline health checks, sync endpoint; no LLM calls):

  ```bash
  make test-e2e-no-llm
  ```

  Uses an isolated compose stack (up → run tests → down).

- **With OpenAI** (full E2E including extraction-quality tests; validates LLM extraction):

  ```bash
  make test-e2e
  ```

  Requires `OPENAI_API_KEY` in your environment; `make test-e2e` loads `.env` from the repo root if present, so a key in `.env` is enough.

### Specification artifacts

- **API contract:** `docs/api.md`
- **Data contracts (JSON Schema):** `docs/contracts/extraction_result.schema.json`, `borrower_record.schema.json`, `application_record.schema.json`
- **Test fixtures:** `fixtures/expected/*.json`, `fixtures/README.md`

---

## Summary of architectural and implementation decisions

### Architecture overview

The system is built as an **event-driven pipeline**: the Adapter API is the only component that **pulls** from external systems; everything downstream is **push/event-driven** via durable queues.

- **Adapter API** — Exposes `POST /sync`, integrates with an external source (list + download), computes a content-addressed `document_id`, stores raw PDFs in the object store, and enqueues `document_available` jobs with a `correlation_id` for traceability.
- **Ingestion Worker** — Consumes `document_available`, validates the stored PDF reference, and emits `extract_text`.
- **Text Extractor Worker** — Extracts page-bounded text from the PDF, runs LLM extraction (text-only) under a schema-constrained contract. If required fields are missing, enqueues `extract_pdf`; otherwise enqueues `persist_records`.
- **PDF Fallback Extractor Worker** — Consumes `extract_pdf` when text-only extraction is incomplete; calls the LLM with the full PDF (vision/layout), merges with stage-1 output, and emits `persist_records`.
- **Persistence Worker** — Upserts BorrowerRecord and ApplicationRecord read models into Postgres (with evidence and completeness status).
- **Query API** — Serves borrower and application read models from Postgres; isolated from ingestion/extraction load for independent scaling.

**Stage queues:** `document_available` → `extract_text` → `extract_pdf` (fallback) → `persist_records`. BullMQ + Redis provide durability, backpressure, retries, and DLQ.

```text
                             ┌───────────────────────────────┐
                             │ External Source System (mock) │
                             │ - GET /documents (list)       │
                             │ - GET /documents/{id} (bytes) │
                             └───────────────┬───────────────┘
                                             ▲
                                             │ call (pull: list + download)
                                             │
┌───────────────────┐          ┌─────────────┴────────────┐ 
│ Clients / LoadGen │─────────►│ Adapter API              │
│ (triggers sync)   │  POST    │ - POST /sync             │
└───────────────────┘  /sync   │ - store raw PDFs         │
                               │ - emit document_available│
                               └─────────────┬────────────┘
                                             │  emits
                                             │  work
                                             │  items
                                             ▼
                               ┌──────────────────────────┐
                               │ Ingestion Worker         │
                               │ - validates raw_uri      │
                               │ - emits extract_text     │
                               └─────────────┬────────────┘
                                             │
                                             │
                                             ▼
                               ┌──────────────────────────┐          ┌───────────────────────────┐
                               │ Extraction Workers       │  call    │ LLM Provider              │
                               │ - text-first             │─────────►│ - schema extraction       │
                               │ - PDF fallback, if needed│          │                           │
                               └─────────────┬────────────┘          └───────────────────────────┘
                                             │ emits
                                             │ facts
                                             ▼
                               ┌──────────────────────────┐
                               │ Persistence Worker       │
                               │ - upsert borrowers       │
                               │   using facts            │
                               └─────────────┬────────────┘
                                             │ call (read/write)
                                             ▼
                               ┌──────────────────────────┐
                               │ Postgres                 │
                               │ - borrowers              │
                               │ - applications           │
                               └─────────────┬────────────┘
                                             ▲
                                             │ call (read)
                               ┌─────────────┴────────────┐
                               │ Query API                │
                               │ - search borrowers       │
                               │ - get by loan_number     │
                               └─────────────┬────────────┘
                                             ▲
                                             │ get /borrowers
                                        ┌────┴────┐
                                        │ Clients │
                                        └─────────┘
```

### Data pipeline design

- **Ingestion:** `POST /sync` triggers list + download from the external source; each PDF is stored at `object-store/raw/{source_system}/{document_id}.pdf` and a `document_available` job is enqueued. Idempotent by `document_id` (content hash).
- **Processing:** Text-first extraction with a PDF+vision fallback when required fields are missing. Extraction produces fact-based results (facts with evidence, names_in_proximity, proximity_score) conforming to `extraction_result.schema.json`.
- **Storage:** Persistence worker resolves borrower identity via a deterministic key (e.g. normalized name + ZIP), merges facts with document-type–weighted confidence scoring and strict income identity keys (see `docs/matching-and-merge-spec.md`), and upserts borrowers, applications, parties, incomes, identifiers, and evidence in a single transaction.
- **Retrieval:** Query API exposes `GET /borrowers`, `GET /borrowers/{id}`, `GET /applications/by-loan/{loan_number}` as defined in `docs/api.md`.

### AI/LLM integration strategy

- **Model selection:** Text-only extraction uses a fast/cheap model (schema compliance + speed); PDF fallback uses a vision-capable model only when stage 1 is incomplete.
- **Prompting and schema:** JSON-schema constrained (or structured) output; post-LLM validation (parse, validate schema, reject/repair).
- **Two-step flow:** (1) Classification — fast model identifies document type (w2, paystub, bank_statement, closing_disclosure, tax_return_1040, evoe, unknown) from text preview. (2) Template-based extraction — document-specific templates encode semantics (e.g. W-2 employee address vs employer address) and proximity scoring to reduce misattribution. Templates live in `packages/shared/src/templates/`; see `docs/facts-based-extraction-spec.md`.

### Approach for handling document format variability

The pipeline philosophy is **facts-first**: extraction produces **candidate facts** from documents (e.g. “this SSN is possibly associated to this individual with this level of confidence”). That stream feeds **persistence**, which evaluates the facts (confidence, identity keys, document-type weights) and upserts backend entities such as borrower records and loan application records. Extraction is **document-scoped** (one document at a time, no cross-document entity resolution); **entity resolution and merge** happen in the persistence layer.

The system is designed to be **extensible** by document type: new types can plug in specialized **algorithm-based extraction**, **LLM extraction with custom prompts** (templates), and a **configurable workflow** that can fail over from algorithm → LLM (text) → LLM (image/vision) as needed.

- **Algorithm-first for predictable forms:** For universal, structured forms (e.g. IRS 1040), we prioritize **algorithm-based extraction** (parsing, patterns) for predictable, deterministic results before involving the LLM.
- **Text-first, then image fallback for LLM:** For documents sent to the LLM, we **prioritize text extraction** from the PDF and submit that text to the LLM; only when the text path does not yield the desired completeness do we **fail over to image/vision** (full PDF) input. That keeps cost and latency lower while still handling poor or scanned PDFs.
- **Classification and templates:** Document-type classification (LLM or heuristic) routes to extraction templates (W2, paystub, verification, bank statement, tax form, closing disclosure, etc.). Page-aware text extraction preserves page boundaries; minimal cleanup (repeated headers/footers, whitespace).
- **Field attribution:** Extracted values are treated as candidates; document-type–weighted confidence scoring and strict income identity keys during merge reduce misattribution (`docs/matching-and-merge-spec.md`). Content-addressed storage (`document_id = sha256(bytes)`) keeps reprocessing idempotent and avoids disk growth on replay.

### Scaling considerations (10x and 100x)

The core design is already a **foundation for scaling**: event-driven stages, durable queues, stateless workers, and a separate Query API give natural horizontal scaling and clear extension points. The following are incremental steps on top of that foundation.

- **10x (single-region):** Scale worker replicas (more `extract_text` and `persist` first; fewer `extract_pdf`). Move object store to S3/GCS. Postgres: larger pool, read replica for Query API.
- **100x:** Replace Redis/BullMQ with a managed queue/event bus (e.g. SQS + workers or Kafka). Partition DB by borrower_id; separate hot borrower data from cold document/provenance; add search index if needed. LLM: batching, request coalescing, text-only-first and page windowing, quota management and multi-provider failover.

### Key technical trade-offs and design decisions

**Trade-offs (choices we made for this scope, with known alternatives at scale):**

- **Redis/BullMQ vs Kafka:** BullMQ is lightweight and sufficient for this scope; the design documents the migration path for 100x.
- **No intermediate persistence:** Queues hold in-flight state; Postgres is the system of record — minimizes complexity while keeping reliability.
- **Addresses not normalized:** Addresses are stored as extracted (no postal/address normalization); production would use full address normalization for matching and deduplication.

**Design decisions we would keep for production:**

- **Text-first + PDF fallback:** Cost-aware and robust without premature page rasterization; we’d retain this ordering in prod.
- **Separate Query API:** Isolates latency-sensitive reads from bursty ingestion; we’d keep read and write paths separated in prod.
- **Stronger downstream logic:** We’d invest in persistence logic that takes the **source of each fact** (document type, authority, provenance) into account to better assess confidence and prioritize facts when merging and resolving entities.

### Error handling and data quality

- **Error taxonomy:** Input validation (400); transient external errors (retry with backoff); permanent extraction errors (DLQ). BullMQ retries with exponential backoff and jitter; repeated failure routes to DLQ.
- **Data quality:** Post-extraction checks for required fields (name, zip), numeric sanity, and cross-field consistency. Outputs tagged with `completeness` (complete|partial), `warnings`, and `missing_fields`. Document-type–weighted scoring and income identity keys reduce misattribution during merge.

### Query / retrieval interface

The Query API serves low-latency read models from Postgres: borrower search and get-by-id, application get-by-loan-number. Endpoints and response shapes are in `docs/api.md`. Separation from ingestion allows independent autoscaling and resource limits.

### Deeper dive

For full detail on orchestration and resilience (BullMQ semantics, backpressure, retries/DLQ, correlation ID propagation), observability (metrics, structured logs, debugging pipeline runs), testing strategy (unit, E2E, load test design, controlled failure injection), read-model shapes and provenance, and full configuration, see **`docs/system-design-document.md`**.

---

## Reference

### Services

| Service         | Port | Description                          |
|----------------|------|--------------------------------------|
| adapter-api    | 8080 | POST /sync, health, metrics          |
| query-api      | 8081 | GET /borrowers, /applications       |
| fixture-source | 9000 | Mock external document source       |
| postgres       | 5432 | PostgreSQL database                 |
| redis          | 6379 | BullMQ job queue                    |

### API endpoints

- **Adapter API (8080):** `POST /sync`, `GET /health`, `GET /metrics`
- **Query API (8081):** `GET /borrowers`, `GET /borrowers/{id}`, `GET /applications/by-loan/{loan_number}`, `GET /health`, `GET /metrics`

### Configuration

| Variable                     | Default      | Description                          |
|-----------------------------|-------------|--------------------------------------|
| OPENAI_API_KEY              | —           | Required                             |
| LLM_MODEL_TEXT              | gpt-4o-mini | Text extraction                      |
| LLM_MODEL_PDF               | gpt-4o      | PDF vision fallback                  |
| BULLMQ_DEFAULT_ATTEMPTS     | 5           | Max job retries                      |
| MAX_QUEUE_DEPTH_WARNING     | 5000        | Queue depth warning                  |
| MAX_QUEUE_DEPTH_REJECT      | 10000       | Adapter reject threshold             |
| ENABLE_CONTROLLED_FAILURES  | false       | Failure injection for testing        |

Full configuration is in the system design document (Appendix B).

### Data contracts

- `docs/contracts/extraction_result.schema.json` — LLM extraction output (fact-based)
- `docs/contracts/borrower_record.schema.json` — Borrower read model
- `docs/contracts/application_record.schema.json` — Application read model

All records include evidence (document_id, source_filename, page_number, quote).

### Project structure

```
services/          adapter-api, query-api, fixture-source, worker-*
packages/shared/    types, queues, logger, config, extractors, templates
observability/      prometheus.yml, grafana/, k6/
fixtures/expected/  Golden JSON outputs
docs/               api.md, contracts/, system-design-document.md
```

### Running tests

```bash
npm test              # Unit tests (all workspaces)
make test-e2e-no-llm   # E2E without OpenAI (pipeline health/sync)
make test-e2e         # Full E2E with OpenAI (requires OPENAI_API_KEY)
```

---

## License

Private — for evaluation purposes only.
