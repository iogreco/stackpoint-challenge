/**
 * BullMQ Queue Definitions
 *
 * Queue names, job interfaces, and queue factory functions.
 */

import { Queue, Worker, Job, ConnectionOptions } from 'bullmq';
import { config } from './config';
import { logger } from './logger';

// ============================================================================
// Queue Names
// ============================================================================

export const QUEUE_NAMES = {
  DOCUMENT_AVAILABLE: 'document_available',
  EXTRACT_TEXT: 'extract_text',
  EXTRACT_PDF: 'extract_pdf',
  PERSIST_RECORDS: 'persist_records',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

// ============================================================================
// Job Payloads
// ============================================================================

/**
 * document.available - Enqueued by adapter after downloading PDF
 */
export interface DocumentAvailableJob {
  event_type: 'document.available';
  correlation_id: string;
  document_id: string;
  raw_uri: string;
  source_system: string;
  source_doc_id: string;
  source_filename: string;
  discovered_at: string;
}

/**
 * extract_text - Enqueued by ingestion worker
 */
export interface ExtractTextJob extends DocumentAvailableJob {
  event_type: 'document.available';
}

/**
 * extract_pdf - Enqueued by text extractor when fallback needed
 */
export interface ExtractPdfJob extends DocumentAvailableJob {
  event_type: 'document.available';
  text_extraction_result?: {
    borrowers: unknown[];
    applications: unknown[];
    missing_fields: string[];
  };
}

/**
 * persist_records - Enqueued after successful extraction
 */
export interface PersistRecordsJob {
  event_type: 'extraction.complete';
  correlation_id: string;
  extraction_result: unknown; // ExtractionResult - avoid circular import
}

// ============================================================================
// Redis Connection
// ============================================================================

export function getRedisConnection(): ConnectionOptions {
  const redisUrl = config.redisUrl;

  if (redisUrl && redisUrl.startsWith('redis://')) {
    try {
      const url = new URL(redisUrl);
      return {
        host: url.hostname,
        port: parseInt(url.port || '6379', 10),
        maxRetriesPerRequest: null, // Required for BullMQ
      };
    } catch {
      // Fall through to host/port
    }
  }

  return {
    host: config.redisHost,
    port: config.redisPort,
    maxRetriesPerRequest: null,
  };
}

// ============================================================================
// Queue Factory
// ============================================================================

const defaultJobOptions = {
  attempts: config.maxJobAttempts,
  backoff: {
    type: 'exponential' as const,
    delay: config.backoffBaseMs,
  },
  removeOnComplete: 100, // Keep last 100 completed jobs
  removeOnFail: 1000, // Keep last 1000 failed jobs
};

export function createQueue<TData, TResult>(queueName: QueueName): Queue<TData, TResult> {
  return new Queue<TData, TResult>(queueName, {
    connection: getRedisConnection(),
    defaultJobOptions,
  });
}

// ============================================================================
// Worker Factory
// ============================================================================

export interface WorkerOptions {
  concurrency?: number;
}

export function createWorker<TData, TResult>(
  queueName: QueueName,
  processor: (job: Job<TData, TResult>) => Promise<TResult>,
  options: WorkerOptions = {}
): Worker<TData, TResult> {
  const worker = new Worker<TData, TResult>(queueName, processor, {
    connection: getRedisConnection(),
    concurrency: options.concurrency || config.workerConcurrency,
  });

  worker.on('completed', (job, result) => {
    logger.info('Job completed', {
      queue: queueName,
      jobId: job.id,
    });
  });

  worker.on('failed', (job, err) => {
    logger.error('Job failed', err, {
      queue: queueName,
      jobId: job?.id,
      attempts: job?.attemptsMade,
    });
  });

  worker.on('error', (err) => {
    logger.error('Worker error', err, { queue: queueName });
  });

  logger.info('Worker started', {
    queue: queueName,
    concurrency: options.concurrency || config.workerConcurrency,
  });

  return worker;
}

// ============================================================================
// Queue Metrics
// ============================================================================

export async function getQueueMetrics(queue: Queue): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}> {
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount(),
  ]);

  return { waiting, active, completed, failed, delayed };
}

/**
 * Check backpressure thresholds
 */
export async function checkBackpressure(queue: Queue): Promise<{
  shouldWarn: boolean;
  shouldReject: boolean;
  depth: number;
}> {
  const metrics = await getQueueMetrics(queue);
  const depth = metrics.waiting + metrics.active;

  return {
    shouldWarn: depth >= config.maxQueueDepthWarning,
    shouldReject: depth >= config.maxQueueDepthReject,
    depth,
  };
}
