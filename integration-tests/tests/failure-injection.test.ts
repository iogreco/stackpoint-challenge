/**
 * Controlled Failure Tests
 *
 * Tests retry behavior and DLQ routing under controlled failures.
 */

import { sleep } from './helpers';

const ADAPTER_API_URL = process.env.ADAPTER_API_URL || 'http://localhost:8080';

describe('Failure Injection Tests', () => {
  // These tests require ENABLE_CONTROLLED_FAILURES=true

  it.skip('should retry on LLM text extraction failure', async () => {
    // Enable FAILPOINT_LLM_TEXT=true
    // Trigger sync and verify job retries

    const response = await fetch(`${ADAPTER_API_URL}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source_system: 'fixture_source',
        max_documents: 1,
      }),
    });

    expect(response.status).toBe(202);

    // Wait for retries
    await sleep(30000);

    // Verify metrics show retries
    const metricsResponse = await fetch(`${ADAPTER_API_URL}/metrics`);
    const metricsText = await metricsResponse.text();

    // Should see failed attempts followed by success
    expect(metricsText).toContain('stackpoint_jobs_processed_total');
  });

  it.skip('should retry on persistence failure', async () => {
    // Enable FAILPOINT_PERSIST=true
    // Similar to above
  });

  it.skip('should fall back to PDF extraction when text extraction incomplete', async () => {
    // This happens naturally when text extraction returns missing_fields
    // Verify extract_pdf queue receives jobs
  });
});

describe('Backpressure Tests', () => {
  it.skip('should reject requests when queue is overloaded', async () => {
    // Flood the system to trigger backpressure
    const promises = [];

    for (let i = 0; i < 100; i++) {
      promises.push(
        fetch(`${ADAPTER_API_URL}/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source_system: 'fixture_source',
            max_documents: 10,
          }),
        })
      );
    }

    const responses = await Promise.all(promises);

    // Some requests should be rejected with 503
    const rejections = responses.filter((r) => r.status === 503);
    const acceptances = responses.filter((r) => r.status === 202);

    // Verify we have both accepted and rejected requests under load
    console.log(`Accepted: ${acceptances.length}, Rejected: ${rejections.length}`);
  });
});
