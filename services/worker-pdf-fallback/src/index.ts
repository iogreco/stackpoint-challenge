/**
 * PDF Fallback Worker
 *
 * Uses OpenAI vision API for fallback extraction when text extraction is incomplete.
 */

import { Job } from 'bullmq';
import {
  logger,
  config,
  runWithContextAsync,
  createWorker,
  createQueue,
  validateExtraction,
  QUEUE_NAMES,
  type ExtractPdfJob,
  type PersistRecordsJob,
  type DocumentInfo,
  jobsProcessedCounter,
  jobDurationHistogram,
  extractionDurationHistogram,
  documentsProcessedCounter,
} from '@stackpoint/shared';
import {
  extractWithVision,
  mergeFacts,
  buildFactExtractionResult,
} from './lib/llm';

// Create queues
const persistRecordsQueue = createQueue<PersistRecordsJob, void>(QUEUE_NAMES.PERSIST_RECORDS);

/**
 * Process extract_pdf job
 */
async function processExtractPdf(job: Job<ExtractPdfJob, void>): Promise<void> {
  const {
    correlation_id,
    document_id,
    raw_uri,
    source_system,
    source_doc_id,
    source_filename,
    discovered_at,
    fact_extraction_result,
  } = job.data;

  return runWithContextAsync(
    { correlationId: correlation_id, documentId: document_id, sourceSystem: source_system },
    async () => {
      const startTime = Date.now();

      logger.info('Processing extract_pdf fallback', {
        jobId: job.id,
        document_id,
        source_filename,
        attempt: job.attemptsMade + 1,
        has_previous_result: !!fact_extraction_result?.facts?.length,
      });

      try {
        // Check for controlled failure injection
        if (config.enableControlledFailures && config.failpointLlmPdf && job.attemptsMade === 0) {
          logger.warn('Controlled failure injection: LLM PDF extraction');
          throw new Error('Controlled failure: LLM PDF extraction');
        }

        // Step 1: Build document info
        const documentInfo: DocumentInfo = {
          document_id,
          source_filename,
          raw_uri,
          source_system,
          source_doc_id,
          discovered_at,
        };

        // Step 2: Call vision API (pass previous text facts if any)
        const filePath = raw_uri.replace('file://', '');
        const { result: visionResult, requestId, model } = await extractWithVision(
          filePath,
          documentInfo,
          correlation_id,
          fact_extraction_result
        );

        // Step 3: Merge text facts with vision facts
        const mergedResult = mergeFacts(fact_extraction_result, visionResult);

        // Step 4: Build fact extraction result
        const factExtractionResult = buildFactExtractionResult(
          mergedResult,
          documentInfo,
          correlation_id,
          model,
          requestId
        );

        // Step 5: Validate against schema
        const validation = validateExtraction(factExtractionResult);

        if (!validation.valid) {
          logger.error('PDF fact extraction validation failed', undefined, {
            errors: validation.errors,
          });
          factExtractionResult.warnings = [
            ...(factExtractionResult.warnings || []),
            'Fact extraction did not fully validate against schema',
          ];
        }

        // Step 6: Enqueue persist_records (fact-based; persistence will run attribution)
        const persistPayload: PersistRecordsJob = {
          event_type: 'extraction.complete',
          correlation_id,
          extraction_result: factExtractionResult,
        };

        await persistRecordsQueue.add('persist_records', persistPayload, {
          jobId: `persist_${source_system}_${document_id.replace(':', '_')}`,
        });

        logger.info('Enqueued persist_records from PDF fallback', {
          document_id,
          fact_count: factExtractionResult.facts.length,
        });

        // Record metrics
        const duration = (Date.now() - startTime) / 1000;
        jobsProcessedCounter.inc({ queue: QUEUE_NAMES.EXTRACT_PDF, status: 'success' });
        jobDurationHistogram.observe({ queue: QUEUE_NAMES.EXTRACT_PDF, status: 'success' }, duration);
        extractionDurationHistogram.observe({ extraction_mode: 'pdf_fallback' }, duration);
        documentsProcessedCounter.inc({
          source_system,
          extraction_mode: 'pdf_fallback',
          status: 'success',
        });
      } catch (error) {
        jobsProcessedCounter.inc({ queue: QUEUE_NAMES.EXTRACT_PDF, status: 'failed' });
        documentsProcessedCounter.inc({
          source_system,
          extraction_mode: 'pdf_fallback',
          status: 'error',
        });
        throw error;
      }
    }
  );
}

// Create and start the worker
const worker = createWorker<ExtractPdfJob, void>(QUEUE_NAMES.EXTRACT_PDF, processExtractPdf);

logger.info('PDF fallback worker started');

// Graceful shutdown
async function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);
  await worker.close();
  await persistRecordsQueue.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
