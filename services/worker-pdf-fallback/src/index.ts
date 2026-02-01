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
  mergeExtractionResults,
  buildExtractionResult,
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
    text_extraction_result,
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
        has_previous_result: !!text_extraction_result,
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

        // Step 2: Call vision API
        const filePath = raw_uri.replace('file://', '');
        const { result: visionResult, requestId, model } = await extractWithVision(
          filePath,
          documentInfo,
          correlation_id,
          text_extraction_result
        );

        // Step 3: Merge with text extraction result
        const mergedResult = mergeExtractionResults(text_extraction_result, visionResult);

        // Step 4: Build extraction result
        const extractionResult = buildExtractionResult(
          mergedResult,
          documentInfo,
          correlation_id,
          model,
          requestId
        );

        // Step 5: Validate against schema
        const validation = validateExtraction(extractionResult);

        if (!validation.valid) {
          logger.error('PDF extraction result validation failed', undefined, {
            errors: validation.errors,
          });
          // Still proceed - partial data is better than no data
          extractionResult.warnings = [
            ...(extractionResult.warnings || []),
            'Extraction result did not fully validate against schema',
          ];
        }

        // Step 6: Enqueue persist_records
        const persistPayload: PersistRecordsJob = {
          event_type: 'extraction.complete',
          correlation_id,
          extraction_result: extractionResult,
        };

        await persistRecordsQueue.add('persist_records', persistPayload, {
          jobId: `persist_${source_system}_${document_id.replace(':', '_')}`,
        });

        logger.info('Enqueued persist_records from PDF fallback', {
          document_id,
          borrower_count: extractionResult.borrowers.length,
          application_count: extractionResult.applications.length,
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
