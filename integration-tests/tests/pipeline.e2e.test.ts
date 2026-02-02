/**
 * E2E Pipeline Tests
 *
 * Tests the complete document sync -> extraction -> persistence -> query flow.
 */

import {
  waitForHealth,
  syncAndWait,
  getBorrowers,
  getBorrowerById,
  getApplicationByLoanNumber,
  sleep,
  stripVolatileFields,
  normalizeForComparison,
} from './helpers';

const ADAPTER_API_URL = process.env.ADAPTER_API_URL || 'http://localhost:8080';
const QUERY_API_URL = process.env.QUERY_API_URL || 'http://localhost:8081';

describe('Document Extraction Pipeline', () => {
  beforeAll(async () => {
    // Wait for services to be healthy
    const adapterHealthy = await waitForHealth(ADAPTER_API_URL, 60000);
    const queryHealthy = await waitForHealth(QUERY_API_URL, 60000);

    if (!adapterHealthy) {
      throw new Error('Adapter API did not become healthy');
    }
    if (!queryHealthy) {
      throw new Error('Query API did not become healthy');
    }
  });

  describe('Health Checks', () => {
    it('should report adapter-api as healthy', async () => {
      const response = await fetch(`${ADAPTER_API_URL}/health`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data.status).toBe('healthy');
      expect(data.service).toBe('adapter-api');
    });

    it('should report query-api as healthy', async () => {
      const response = await fetch(`${QUERY_API_URL}/health`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data.status).toBe('healthy');
      expect(data.service).toBe('query-api');
    });
  });

  describe('Sync Endpoint', () => {
    it('should accept sync request and return correlation_id', async () => {
      const response = await fetch(`${ADAPTER_API_URL}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_system: 'fixture_source',
          max_documents: 1,
        }),
      });

      expect(response.status).toBe(202);

      const data = await response.json();
      expect(data.correlation_id).toBeDefined();
      expect(typeof data.correlation_id).toBe('string');
    });

    it('should reject sync without source_system', async () => {
      const response = await fetch(`${ADAPTER_API_URL}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error.code).toBe('invalid_request');
    });
  });

  describe('Query Endpoints', () => {
    it('should return empty list when no borrowers exist', async () => {
      const response = await fetch(`${QUERY_API_URL}/borrowers`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data.items).toBeDefined();
      expect(Array.isArray(data.items)).toBe(true);
    });

    it('should return 404 for non-existent borrower', async () => {
      const response = await fetch(`${QUERY_API_URL}/borrowers/00000000-0000-0000-0000-000000000000`);
      expect(response.status).toBe(404);

      const data = await response.json();
      expect(data.error.code).toBe('not_found');
    });

    it('should return 404 for non-existent application', async () => {
      const response = await fetch(`${QUERY_API_URL}/applications/by-loan/NONEXISTENT123`);
      expect(response.status).toBe(404);

      const data = await response.json();
      expect(data.error.code).toBe('not_found');
    });

    it('should support borrower search filters', async () => {
      const response = await fetch(`${QUERY_API_URL}/borrowers?name=test&zip=12345&status=COMPLETE`);
      expect(response.ok).toBe(true);

      const data = await response.json();
      expect(data.items).toBeDefined();
    });

    it('should reject invalid status filter', async () => {
      const response = await fetch(`${QUERY_API_URL}/borrowers?status=INVALID`);
      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error.code).toBe('invalid_request');
    });
  });

  describe('Metrics Endpoint', () => {
    it('should expose Prometheus metrics on adapter-api', async () => {
      const response = await fetch(`${ADAPTER_API_URL}/metrics`);
      expect(response.ok).toBe(true);

      const text = await response.text();
      expect(text).toContain('stackpoint_');
    });

    it('should expose Prometheus metrics on query-api', async () => {
      const response = await fetch(`${QUERY_API_URL}/metrics`);
      expect(response.ok).toBe(true);

      const text = await response.text();
      expect(text).toContain('stackpoint_');
    });
  });
});

describe('Full Pipeline Integration', () => {
  // These tests require the full pipeline to be running with OpenAI API key

  it.skip('should process a document through the full pipeline', async () => {
    // This test requires OpenAI API key and full pipeline

    // Trigger sync
    const { correlationId } = await syncAndWait('fixture_source', 1, 120000);
    expect(correlationId).toBeDefined();

    // Wait for processing
    await sleep(30000);

    // Query for borrowers
    const borrowers = await getBorrowers();
    expect(borrowers.length).toBeGreaterThan(0);

    // Verify borrower has expected structure
    const borrower = borrowers[0];
    expect(borrower.schema_version).toBe('1.1.0');
    expect(borrower.borrower_id).toBeDefined();
    expect(borrower.full_name).toBeDefined();
    expect(borrower.status).toMatch(/^(COMPLETE|PARTIAL)$/);
  });

  it.skip('should match golden output after processing', async () => {
    // This test compares against fixtures/expected/

    const borrowers = await getBorrowers({ name: 'John Homeowner' });
    expect(borrowers.length).toBeGreaterThan(0);

    const borrower = stripVolatileFields(borrowers[0], 'borrower');
    const normalized = normalizeForComparison(borrower);

    // Load golden output
    const golden = require('../../fixtures/expected/john_homeowner.borrower_record.json');
    const goldenNormalized = normalizeForComparison(
      stripVolatileFields(golden, 'borrower')
    );

    // Compare key fields (not exact match due to LLM variance)
    expect(normalized.full_name).toBe(goldenNormalized.full_name);
    expect(normalized.status).toBe(goldenNormalized.status);
  });
});
