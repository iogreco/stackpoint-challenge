# API Contract

This system exposes two HTTP services:

- **Ingest API** (async ingestion): `http://localhost:8080`
- **Query API** (low-latency reads): `http://localhost:8081`

Both services expose Prometheus metrics at `GET /metrics`.

---

## Common conventions

### Correlation ID

Clients may supply an id for tracing:

- Request header: `X-Correlation-Id: <uuid-or-string>`

If omitted, the system generates a `correlation_id`. This ID is propagated through queue messages and appears in logs/metrics.

### Error envelope

All non-2xx responses return:

```json
{
  "error": {
    "code": "invalid_request",
    "message": "Human-readable message",
    "correlation_id": "00000000-0000-0000-0000-000000000000"
  }
}
```

---

# 1) Ingest API

## `POST /ingest`

Fetches a PDF from an external source (via a source adapter), stores it in the object store, and enqueues downstream extraction.

### Request body

```json
{
  "source_system": "fixture_source",
  "source_url": "http://fixture-source:9000/docs/closing_disclosure.pdf",
  "source_filename": "Closing_Disclosure.pdf"
}
```

**Notes**
- `source_url` is fetched by the adapter.
- `source_filename` is the original filename for provenance; it is stored verbatim.
- The system computes a stable `document_id` for idempotency (recommended: SHA-256 of the PDF bytes).

### Response

- `202 Accepted`

```json
{
  "correlation_id": "00000000-0000-0000-0000-000000000003",
  "document_id": "3333333333333333333333333333333333333333333333333333333333333333",
  "raw_uri": "file://storage/raw/fixture_source/3333333333333333333333333333333333333333333333333333333333333333.pdf"
}
```

### Errors

- `400` invalid request body
- `422` unsupported file type / invalid PDF
- `502` source adapter fetch failed

---

# 2) Query API

The Query API serves read models persisted in Postgres and is isolated from ingestion load.

All successful responses are JSON and conform to the JSON Schemas in `docs/contracts/`.

## `GET /borrowers/{borrower_id}`

Returns the borrower record for a single individual borrower.

### Response

- `200 OK`
- Body conforms to: `docs/contracts/borrower_record.schema.json`

### Errors

- `404` borrower not found

---

## `GET /borrowers`

Search + pagination for borrowers.

### Query parameters

- `name` (optional): case-insensitive substring match on borrower full name
- `zip` (optional): exact ZIP match
- `status` (optional): `COMPLETE` or `PARTIAL`
- `limit` (optional): default 20, max 100
- `cursor` (optional): opaque cursor

### Response

- `200 OK`

```json
{
  "items": [ /* BorrowerRecord[] */ ],
  "next_cursor": "opaque-string-or-null"
}
```

Each item conforms to: `docs/contracts/borrower_record.schema.json`.

### Errors

- `400` invalid query parameters

---

## `GET /applications/by-loan/{loan_number}`

Returns the application (loan party-group) for a loan number.

This endpoint is the primary way to retrieve a record when the user has a loan number. It also supports the assignment requirement that borrower records include associated loan numbers.

### Response

- `200 OK`
- Body conforms to: `docs/contracts/application_record.schema.json`

### Errors

- `404` application not found
