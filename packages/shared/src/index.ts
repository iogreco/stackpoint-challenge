/**
 * Shared Package - Main Export
 */

// Context
export {
  getContext,
  getCorrelationId,
  runWithContext,
  runWithContextAsync,
  asyncLocalStorage,
  type RequestContext,
} from './context';

// Logger
export { logger, type LogContext } from './logger';

// Config
export { config, type Config } from './config';

// Types
export * from './types';

// Evidence weights (matching-and-merge-spec §4.4)
export {
  EVIDENCE_WEIGHTS,
  DEFAULT_EVIDENCE_WEIGHT,
  getEvidenceWeight,
} from './evidence-weights';

// Queues
export {
  QUEUE_NAMES,
  type QueueName,
  type DocumentAvailableJob,
  type ExtractTextJob,
  type ExtractPdfJob,
  type PersistRecordsJob,
  getRedisConnection,
  createQueue,
  createWorker,
  getQueueMetrics,
  checkBackpressure,
  type WorkerOptions,
} from './queues';

// Metrics
export {
  register,
  queueDepthGauge,
  queueMetricsGauge,
  jobDurationHistogram,
  jobsProcessedCounter,
  documentsProcessedCounter,
  extractionDurationHistogram,
  llmRequestsCounter,
  llmRequestDurationHistogram,
  backpressureRejectionsCounter,
  httpRequestDurationHistogram,
  httpRequestsCounter,
  dbQueryDurationHistogram,
  getMetrics,
  getMetricsContentType,
} from './metrics';

// Schemas
export { validateExtraction, validateBorrower, validateApplication, schemas } from './schemas';
