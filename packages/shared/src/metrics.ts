/**
 * Prometheus Metrics
 *
 * Metrics for monitoring queue depth, job processing, and system health.
 */

import http from 'node:http';
import type { Queue } from 'bullmq';
import * as promClient from 'prom-client';
import { logger } from './logger';
import { getQueueMetrics } from './queues';

// Create a Registry for metrics
export const register = new promClient.Registry();

// Default metrics (CPU, memory, etc.) - wrap to avoid crashes on Alpine/restricted environments
try {
  promClient.collectDefaultMetrics({ register });
} catch (err) {
  logger.warn('Default Prometheus metrics collection skipped', {
    error: err instanceof Error ? err.message : String(err),
  });
}

// ============================================================================
// Queue Metrics
// ============================================================================

export const queueDepthGauge = new promClient.Gauge({
  name: 'stackpoint_queue_depth',
  help: 'Current queue depth (waiting + active jobs)',
  labelNames: ['queue'],
  registers: [register],
});

export const queueMetricsGauge = new promClient.Gauge({
  name: 'stackpoint_queue_metrics',
  help: 'Queue metrics by state',
  labelNames: ['queue', 'state'],
  registers: [register],
});

// ============================================================================
// Job Processing Metrics
// ============================================================================

export const jobDurationHistogram = new promClient.Histogram({
  name: 'stackpoint_job_duration_seconds',
  help: 'Duration of job processing in seconds',
  labelNames: ['queue', 'status'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [register],
});

export const jobsProcessedCounter = new promClient.Counter({
  name: 'stackpoint_jobs_processed_total',
  help: 'Total number of jobs processed',
  labelNames: ['queue', 'status'],
  registers: [register],
});

// ============================================================================
// Pipeline Metrics
// ============================================================================

export const documentsProcessedCounter = new promClient.Counter({
  name: 'stackpoint_documents_processed_total',
  help: 'Total number of documents processed through the pipeline',
  labelNames: ['source_system', 'extraction_mode', 'status'],
  registers: [register],
});

export const extractionDurationHistogram = new promClient.Histogram({
  name: 'stackpoint_extraction_duration_seconds',
  help: 'Duration of document extraction',
  labelNames: ['extraction_mode'],
  buckets: [1, 2, 5, 10, 20, 30, 60, 120],
  registers: [register],
});

export const llmRequestsCounter = new promClient.Counter({
  name: 'stackpoint_llm_requests_total',
  help: 'Total number of LLM requests',
  labelNames: ['model', 'status'],
  registers: [register],
});

export const llmRequestDurationHistogram = new promClient.Histogram({
  name: 'stackpoint_llm_request_duration_seconds',
  help: 'Duration of LLM requests',
  labelNames: ['model'],
  buckets: [1, 2, 5, 10, 20, 30, 60],
  registers: [register],
});

// ============================================================================
// Backpressure Metrics
// ============================================================================

export const backpressureRejectionsCounter = new promClient.Counter({
  name: 'stackpoint_backpressure_rejections_total',
  help: 'Total number of requests rejected due to backpressure',
  registers: [register],
});

// ============================================================================
// HTTP Request Metrics
// ============================================================================

export const httpRequestDurationHistogram = new promClient.Histogram({
  name: 'stackpoint_http_request_duration_seconds',
  help: 'Duration of HTTP requests',
  labelNames: ['method', 'path', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register],
});

export const httpRequestsCounter = new promClient.Counter({
  name: 'stackpoint_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'path', 'status'],
  registers: [register],
});

// ============================================================================
// Database Metrics
// ============================================================================

export const dbQueryDurationHistogram = new promClient.Histogram({
  name: 'stackpoint_db_query_duration_seconds',
  help: 'Duration of database queries',
  labelNames: ['operation'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2],
  registers: [register],
});

/**
 * Report queue depths and state metrics to Prometheus gauges.
 * Call before getMetrics() so scrapes include current queue state.
 */
export async function reportQueueMetrics(
  queues: Array<{ name: string; queue: Queue }>
): Promise<void> {
  for (const { name, queue } of queues) {
    try {
      const m = await getQueueMetrics(queue);
      const depth = m.waiting + m.active;
      queueDepthGauge.set({ queue: name }, depth);
      queueMetricsGauge.set({ queue: name, state: 'waiting' }, m.waiting);
      queueMetricsGauge.set({ queue: name, state: 'active' }, m.active);
      queueMetricsGauge.set({ queue: name, state: 'completed' }, m.completed);
      queueMetricsGauge.set({ queue: name, state: 'failed' }, m.failed);
      queueMetricsGauge.set({ queue: name, state: 'delayed' }, m.delayed);
    } catch {
      queueDepthGauge.set({ queue: name }, -1);
    }
  }
}

/**
 * Get Prometheus metrics endpoint handler
 */
export async function getMetrics(): Promise<string> {
  return register.metrics();
}

/**
 * Get content type for Prometheus metrics
 */
export function getMetricsContentType(): string {
  return register.contentType;
}

/**
 * Start a minimal HTTP server for /metrics (for worker processes).
 * Uses Node built-in http - no express required.
 */
export function serveMetrics(port: number): void {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/metrics' && req.method === 'GET') {
      res.setHeader('Content-Type', getMetricsContentType());
      res.end(await getMetrics());
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  server.listen(port, () => {
    logger.info('Metrics server listening', { port });
  });
}
