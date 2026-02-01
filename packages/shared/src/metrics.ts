/**
 * Prometheus Metrics
 *
 * Metrics for monitoring queue depth, job processing, and system health.
 */

import * as promClient from 'prom-client';

// Create a Registry for metrics
export const register = new promClient.Registry();

// Default metrics (CPU, memory, etc.)
promClient.collectDefaultMetrics({ register });

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
