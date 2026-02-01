# API Contract

This system exposes two HTTP services:

- **Adapter API** (pull from external systems): `http://localhost:8080`
- **Query API** (low-latency reads): `http://localhost:8081`

Workers (ingestion/extraction/persistence) are **queue-driven** and do not require public HTTP endpoints.

Both HTTP services expose Prometheus metrics at `GET /metrics`.

---

## Common conventions

### Correlation ID

Clients MAY supply an id for tracing:

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

# 1) Adapter API

The Adapter is the only component that **pulls** from external systems. Everything downstream is **push/event-driven**.

## `POST /sync`

Triggers a single sync pass against a configured external system:
1) list new documents
2) download each document
3) store raw PDF into the object store (demo: shared filesystem)
4) enqueue `document.available` work items for the downstream pipeline

### `document.available` job payload (enqueued to `document_available`)

Note: The event type is `document.available` and it is enqueued onto the BullMQ queue named `document_available`.


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


### Request body

```json
{
  "source_system": "fixture_source",
  "since_cursor": "opaque-string-or-null",
  "max_documents": 50
}
```

- `since_cursor` is passed through to the external system’s list endpoint (if supported).
- `max_documents` bounds how many documents the adapter will download in this pass.

### Response

- `202 Accepted`

```json
{
  "correlation_id": "00000000-0000-0000-0000-000000000003"
}
```

### Errors

- `400` invalid request body
- `502` external system list/download failure

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

---

# 3) External Source API (mock fixture source)

This is the minimal external API shape the Adapter integrates with in the demo.

*Implementation note (demo):* reads PDFs from `/data`.

Base URL (docker-compose): `http://fixture-source:9000`

## `GET /documents`

Lists documents available for sync.

### Query parameters

- `since_cursor` (optional): opaque cursor

### Response

- `200 OK`

```json
{
  "items": [
    {
      "source_doc_id": "doc_001",
      "filename": "Closing_Disclosure.pdf",
      "download_url": "http://fixture-source:9000/documents/doc_001",
      "updated_at": "2026-01-31T22:00:00Z"
    }
  ],
  "next_cursor": "opaque-string-or-null"
}
```

## `GET /documents/{source_doc_id}`

Downloads the raw PDF bytes for a document.
