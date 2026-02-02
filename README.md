# Loan Document Extraction System

An event-driven document extraction pipeline that extracts borrower PII, income history, and loan data from PDFs using LLM-based extraction with provenance tracking.

## Architecture

```
External Source (mock) → Adapter API → [BullMQ Queues] → Workers → Postgres → Query API
                            ↓
                      Object Store (local FS)
```

**Queues:** `document_available` → `extract_text` → `extract_pdf` (fallback) → `persist_records`

## Quick Start

### Prerequisites

- Docker and Docker Compose
- Node.js 18+
- OpenAI API key (for LLM extraction)

### Setup

```bash
# Install dependencies
npm install

# Build the shared package
npm run build --workspace=@stackpoint/shared

# Set OpenAI API key
export OPENAI_API_KEY=your-api-key-here

# Start all services
make up

# View logs
make logs
```

### Verify Services

```bash
# Health checks
make health

# Trigger a document sync
make sync

# List borrowers
make borrowers
```

## Services

| Service | Port | Description |
|---------|------|-------------|
| adapter-api | 8080 | POST /sync - Triggers document sync |
| query-api | 8081 | GET /borrowers, /applications |
| fixture-source | 9000 | Mock external document source |
| postgres | 5432 | PostgreSQL database |
| redis | 6379 | BullMQ job queue |

## API Endpoints

### Adapter API (port 8080)

- `POST /sync` - Trigger document sync
- `GET /health` - Health check
- `GET /metrics` - Prometheus metrics

### Query API (port 8081)

- `GET /borrowers` - Search borrowers
- `GET /borrowers/{id}` - Get borrower by ID
- `GET /applications/by-loan/{loan_number}` - Get application by loan number
- `GET /health` - Health check
- `GET /metrics` - Prometheus metrics

## Development

### Project Structure

```
services/
  adapter-api/          # POST /sync endpoint
  query-api/            # GET endpoints
  fixture-source/       # Mock external API
  worker-ingestion/     # Consumes document_available
  worker-text-extractor/ # Text-first LLM extraction
  worker-pdf-fallback/  # Vision API fallback
  worker-persistence/   # Postgres upserts
packages/
  shared/               # Common code (types, queue, logger, config)
observability/
  prometheus.yml        # Metrics scraping
  grafana/              # Dashboard provisioning
  k6/                   # Load test scripts
fixtures/
  expected/             # Golden JSON outputs
data/                   # Test PDFs
docs/
  contracts/            # JSON schemas
  api.md                # API contract
  system-design-document.md
```

### Running Tests

```bash
# All unit tests (fast, no API calls, uses fixtures)
npm test

# Extraction quality unit tests only
npm test -- --testPathPattern="extraction-quality.test"

# Attribution logic tests
npm test -- --testPathPattern="attribution"
```

#### E2E Tests (require running services)

E2E tests run against the live extraction pipeline and require:
- Running services (`make up`)
- Valid `OPENAI_API_KEY` environment variable

```bash
# E2E extraction quality tests (validates LLM extraction quality)
RUN_E2E_TESTS=1 npm test -- --testPathPattern="extraction-quality.e2e"

# All E2E tests
make test-e2e
```

#### What the Tests Cover

| Test Suite | Description |
|------------|-------------|
| `extraction-quality.test.ts` | Validates extraction against fixture files (SSN for both taxpayers, multi-name attribution, employer address filtering) |
| `extraction-quality.e2e.test.ts` | Live extraction tests (SSN merging, confidence scoring, joint income attribution) |
| `attribution.test.ts` | Unit tests for fact-to-borrower attribution logic |
| `pipeline.e2e.test.ts` | Basic API health and endpoint tests |

### Observability

```bash
# Start with Prometheus + Grafana
make obs-setup

# Run load tests
make obs-load

# Access dashboards
# Prometheus: http://localhost:9090
# Grafana: http://localhost:3004 (admin/admin)
```

## Data Contracts

Schemas in `docs/contracts/`:

- `extraction_result.schema.json` - LLM extraction output
- `borrower_record.schema.json` - Borrower read model
- `application_record.schema.json` - Application read model

All records include evidence with document provenance (document_id, source_filename, page_number, quote).

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| OPENAI_API_KEY | - | OpenAI API key (required) |
| LLM_MODEL_TEXT | gpt-4o-mini | Model for text extraction |
| LLM_MODEL_PDF | gpt-4o | Model for PDF vision fallback |
| BULLMQ_DEFAULT_ATTEMPTS | 5 | Max job retry attempts |
| MAX_QUEUE_DEPTH_WARNING | 5000 | Queue depth warning threshold |
| MAX_QUEUE_DEPTH_REJECT | 10000 | Queue depth rejection threshold |
| ENABLE_CONTROLLED_FAILURES | false | Enable failure injection for testing |

## License

Private - for evaluation purposes only.
