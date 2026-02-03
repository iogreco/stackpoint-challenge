/**
 * Ingestion Worker
 *
 * Consumes document_available queue, validates raw_uri exists,
 * and enqueues extract_text job.
 */

import fs from 'fs';
import { Job } from 'bullmq';
import {
  logger,
  runWithContextAsync,
  createWorker,
  createQueue,
  serveMetrics,
  QUEUE_NAMES,
  type DocumentAvailableJob,
  type ExtractTextJob,
  jobsProcessedCounter,
  jobDurationHistogram,
} from '@stackpoint/shared';

// Create queues
const extractTextQueue = createQueue<ExtractTextJob, void>(QUEUE_NAMES.EXTRACT_TEXT);

/**
 * Process document_available job
 */
async function processDocumentAvailable(
  job: Job<DocumentAvailableJob, void>
): Promise<void> {
  const { correlation_id, document_id, raw_uri, source_system, source_doc_id, source_filename } =
    job.data;

  return runWithContextAsync(
    { correlationId: correlation_id, documentId: document_id, sourceSystem: source_system },
    async () => {
      const startTime = Date.now();

      logger.info('Processing document_available', {
        jobId: job.id,
        document_id,
        source_doc_id,
        source_filename,
        attempt: job.attemptsMade + 1,
      });

      try {
        // Validate raw_uri exists
        const filePath = raw_uri.replace('file://', '');

        if (!fs.existsSync(filePath)) {
          throw new Error(`Raw file not found: ${filePath}`);
        }

        const stats = fs.statSync(filePath);
        logger.info('Validated raw file', {
          document_id,
          size_bytes: stats.size,
        });

        // Enqueue extract_text job
        const extractTextPayload: ExtractTextJob = {
          ...job.data,
        };

        await extractTextQueue.add('extract_text', extractTextPayload, {
          jobId: `extract_${source_system}_${document_id.replace(':', '_')}`,
        });

        logger.info('Enqueued extract_text job', {
          document_id,
          source_doc_id,
        });

        // Record metrics
        const duration = (Date.now() - startTime) / 1000;
        jobsProcessedCounter.inc({ queue: QUEUE_NAMES.DOCUMENT_AVAILABLE, status: 'success' });
        jobDurationHistogram.observe(
          { queue: QUEUE_NAMES.DOCUMENT_AVAILABLE, status: 'success' },
          duration
        );
      } catch (error) {
        jobsProcessedCounter.inc({ queue: QUEUE_NAMES.DOCUMENT_AVAILABLE, status: 'failed' });
        throw error;
      }
    }
  );
}

// Expose /metrics for Prometheus
serveMetrics(9091);

// Create and start the worker
const worker = createWorker<DocumentAvailableJob, void>(
  QUEUE_NAMES.DOCUMENT_AVAILABLE,
  processDocumentAvailable
);

logger.info('Ingestion worker started');

// Graceful shutdown
async function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);
  await worker.close();
  await extractTextQueue.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
