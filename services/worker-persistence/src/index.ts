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
  serveMetrics,
  QUEUE_NAMES,
  type PersistRecordsJob,
  type ExtractionResult,
  type FactExtractionResult,
  isFactExtractionResult,
  jobsProcessedCounter,
  jobDurationHistogram,
} from '@stackpoint/shared';
import { persistExtractionResult, pool } from './lib/db';
import { attributeFacts } from './lib/attribution';

/**
 * Process persist_records job
 */
async function processPersistRecords(job: Job<PersistRecordsJob, void>): Promise<void> {
  const { correlation_id, extraction_result } = job.data;

  const isFactBased = isFactExtractionResult(extraction_result as ExtractionResult | FactExtractionResult);

  // Log the incoming facts payload for debugging/analysis
  if (isFactBased) {
    const factResult = extraction_result as FactExtractionResult;
    logger.info('Received facts payload', {
      correlation_id,
      schema_version: factResult.schema_version,
      document_id: factResult.document?.document_id,
      source_filename: factResult.document?.source_filename,
      extraction_mode: factResult.extraction_mode,
      fact_count: factResult.facts?.length ?? 0,
      facts: factResult.facts?.map((f) => ({
        fact_type: f.fact_type,
        value: f.value,
        names_in_proximity: f.names_in_proximity?.map((n) => ({
          full_name: n.full_name,
          proximity_score: n.proximity_score,
        })),
        evidence_count: f.evidence?.length ?? 0,
        evidence_contexts: f.evidence?.map((e) => e.evidence_source_context).filter(Boolean),
      })),
    });
  }

  let result: ExtractionResult;
  try {
    result = isFactBased
      ? attributeFacts(extraction_result as FactExtractionResult, correlation_id)
      : (extraction_result as ExtractionResult);
  } catch (err) {
    logger.error('Attribution failed', err, {
      correlation_id,
      isFactBased,
      fact_count: isFactBased ? (extraction_result as FactExtractionResult).facts?.length : 0,
    });
    throw err;
  }

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
        from_facts: isFactBased,
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

// Expose /metrics for Prometheus
serveMetrics(9091);

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
