/**
 * Persistence Worker
 *
 * Consumes persist_records queue and upserts to Postgres.
 */

import { Job } from 'bullmq';
import {
  logger,
  config,
  runWithContextAsync,
  createWorker,
  QUEUE_NAMES,
  type PersistRecordsJob,
  type ExtractionResult,
  jobsProcessedCounter,
  jobDurationHistogram,
} from '@stackpoint/shared';
import { persistExtractionResult, pool } from './lib/db';

/**
 * Process persist_records job
 */
async function processPersistRecords(job: Job<PersistRecordsJob, void>): Promise<void> {
  const { correlation_id, extraction_result } = job.data;
  const result = extraction_result as ExtractionResult;

  return runWithContextAsync(
    {
      correlationId: correlation_id,
      documentId: result.document.document_id,
      sourceSystem: result.document.source_system,
    },
    async () => {
      const startTime = Date.now();

      logger.info('Processing persist_records', {
        jobId: job.id,
        document_id: result.document.document_id,
        borrower_count: result.borrowers.length,
        application_count: result.applications.length,
        attempt: job.attemptsMade + 1,
      });

      try {
        // Check for controlled failure injection
        if (config.enableControlledFailures && config.failpointPersist && job.attemptsMade === 0) {
          logger.warn('Controlled failure injection: persistence');
          throw new Error('Controlled failure: persistence');
        }

        // Persist to database
        await persistExtractionResult(result, correlation_id);

        // Record metrics
        const duration = (Date.now() - startTime) / 1000;
        jobsProcessedCounter.inc({ queue: QUEUE_NAMES.PERSIST_RECORDS, status: 'success' });
        jobDurationHistogram.observe(
          { queue: QUEUE_NAMES.PERSIST_RECORDS, status: 'success' },
          duration
        );

        logger.info('Persist complete', {
          document_id: result.document.document_id,
          duration_seconds: duration,
        });
      } catch (error) {
        jobsProcessedCounter.inc({ queue: QUEUE_NAMES.PERSIST_RECORDS, status: 'failed' });
        throw error;
      }
    }
  );
}

// Create and start the worker
const worker = createWorker<PersistRecordsJob, void>(
  QUEUE_NAMES.PERSIST_RECORDS,
  processPersistRecords
);

logger.info('Persistence worker started');

// Graceful shutdown
async function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);
  await worker.close();
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
