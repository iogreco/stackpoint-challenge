/**
 * k6 Load Test Script
 *
 * Tests the document sync pipeline under load with three phases:
 * 1. Warm-up (steady): Baseline constant sync rate
 * 2. Burst: Short high-rate spike to grow queue depth
 * 3. Recovery: Load drops, queues drain to steady-state
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Counter, Trend } from 'k6/metrics';

// Custom metrics
const syncSuccessRate = new Rate('sync_success_rate');
const syncDuration = new Trend('sync_duration_ms');
const syncTotal = new Counter('sync_total');
const backpressureRejections = new Counter('backpressure_rejections');

// Configuration
const ADAPTER_API_URL = __ENV.ADAPTER_API_URL || 'http://adapter-api:8080';

export const options = {
  scenarios: {
    // Phase 1: Warm-up (steady baseline)
    warmup: {
      executor: 'constant-arrival-rate',
      rate: 2, // 2 requests per second
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 5,
      maxVUs: 10,
      startTime: '0s',
    },
    // Phase 2: Burst (high rate spike)
    burst: {
      executor: 'constant-arrival-rate',
      rate: 10, // 10 requests per second
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 20,
      maxVUs: 50,
      startTime: '30s',
    },
    // Phase 3: Recovery (reduced rate, queues drain)
    recovery: {
      executor: 'constant-arrival-rate',
      rate: 1, // 1 request per second
      timeUnit: '1s',
      duration: '60s',
      preAllocatedVUs: 3,
      maxVUs: 5,
      startTime: '60s',
    },
  },
  thresholds: {
    sync_success_rate: ['rate>0.9'], // 90% success rate
    sync_duration_ms: ['p(95)<5000'], // 95th percentile under 5s
    http_req_failed: ['rate<0.1'], // Less than 10% failed requests
  },
};

export default function () {
  const payload = JSON.stringify({
    source_system: 'fixture_source',
    max_documents: 1,
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
    },
    timeout: '10s',
  };

  const startTime = Date.now();
  const response = http.post(`${ADAPTER_API_URL}/sync`, payload, params);
  const duration = Date.now() - startTime;

  syncTotal.add(1);
  syncDuration.add(duration);

  const success = check(response, {
    'status is 202': (r) => r.status === 202,
    'has correlation_id': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.correlation_id !== undefined;
      } catch {
        return false;
      }
    },
  });

  syncSuccessRate.add(success);

  // Track backpressure rejections
  if (response.status === 503) {
    backpressureRejections.add(1);
  }

  // Small delay between requests
  sleep(0.1);
}

export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
    '/scripts/results/summary.json': JSON.stringify(data, null, 2),
  };
}

function textSummary(data, options) {
  const lines = [];
  lines.push('\n=== Load Test Summary ===\n');

  // Overall stats
  lines.push(`Total Syncs: ${data.metrics.sync_total?.values?.count || 0}`);
  lines.push(`Success Rate: ${((data.metrics.sync_success_rate?.values?.rate || 0) * 100).toFixed(1)}%`);
  lines.push(`Backpressure Rejections: ${data.metrics.backpressure_rejections?.values?.count || 0}`);

  // Duration stats
  const duration = data.metrics.sync_duration_ms?.values;
  if (duration) {
    lines.push(`\nSync Duration:`);
    lines.push(`  p50: ${duration.med?.toFixed(0) || 'N/A'}ms`);
    lines.push(`  p95: ${duration['p(95)']?.toFixed(0) || 'N/A'}ms`);
    lines.push(`  max: ${duration.max?.toFixed(0) || 'N/A'}ms`);
  }

  // HTTP stats
  const httpReqs = data.metrics.http_reqs?.values;
  if (httpReqs) {
    lines.push(`\nHTTP Requests:`);
    lines.push(`  Total: ${httpReqs.count || 0}`);
    lines.push(`  Rate: ${httpReqs.rate?.toFixed(2) || 'N/A'} req/s`);
  }

  // Thresholds
  lines.push(`\nThresholds:`);
  for (const [name, threshold] of Object.entries(data.metrics)) {
    if (threshold.thresholds) {
      for (const [key, result] of Object.entries(threshold.thresholds)) {
        const status = result.ok ? 'PASS' : 'FAIL';
        lines.push(`  ${name} ${key}: ${status}`);
      }
    }
  }

  return lines.join('\n');
}
