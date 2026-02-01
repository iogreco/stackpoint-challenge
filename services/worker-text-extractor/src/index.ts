/**
 * Text Extractor Worker
 *
 * Extracts text from PDF, calls LLM for structured extraction,
 * enqueues persist_records or extract_pdf fallback.
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
  type ExtractTextJob,
  type ExtractPdfJob,
  type PersistRecordsJob,
  type DocumentInfo,
  jobsProcessedCounter,
  jobDurationHistogram,
  extractionDurationHistogram,
  documentsProcessedCounter,
} from '@stackpoint/shared';
import { extractTextFromPdf } from './lib/pdf';
import { extractWithLlm, buildExtractionResult, needsPdfFallback } from './lib/llm';

// Create queues
const extractPdfQueue = createQueue<ExtractPdfJob, void>(QUEUE_NAMES.EXTRACT_PDF);
const persistRecordsQueue = createQueue<PersistRecordsJob, void>(QUEUE_NAMES.PERSIST_RECORDS);

/**
 * Process extract_text job
 */
async function processExtractText(job: Job<ExtractTextJob, void>): Promise<void> {
  const {
    correlation_id,
    document_id,
    raw_uri,
    source_system,
    source_doc_id,
    source_filename,
    discovered_at,
  } = job.data;

  return runWithContextAsync(
    { correlationId: correlation_id, documentId: document_id, sourceSystem: source_system },
    async () => {
      const startTime = Date.now();

      logger.info('Processing extract_text', {
        jobId: job.id,
        document_id,
        source_filename,
        attempt: job.attemptsMade + 1,
      });

      try {
        // Check for controlled failure injection
        if (config.enableControlledFailures && config.failpointLlmText && job.attemptsMade === 0) {
          logger.warn('Controlled failure injection: LLM text extraction');
          throw new Error('Controlled failure: LLM text extraction');
        }

        // Step 1: Extract text from PDF
        const filePath = raw_uri.replace('file://', '');
        const pdfResult = await extractTextFromPdf(filePath);

        // Step 2: Build document info
        const documentInfo: DocumentInfo = {
          document_id,
          source_filename,
          raw_uri,
          source_system,
          source_doc_id,
          discovered_at,
        };

        // Step 3: Call LLM for extraction
        const { result: llmResult, requestId, model } = await extractWithLlm(
          pdfResult.pages,
          documentInfo,
          correlation_id
        );

        // Step 4: Build extraction result
        const extractionResult = buildExtractionResult(
          llmResult,
          documentInfo,
          correlation_id,
          model,
          requestId
        );

        // Step 5: Validate against schema
        const validation = validateExtraction(extractionResult);

        if (!validation.valid) {
          logger.warn('Extraction result validation failed, attempting PDF fallback', {
            errors: validation.errors,
          });

          // Enqueue PDF fallback
          const fallbackPayload: ExtractPdfJob = {
            ...job.data,
            text_extraction_result: {
              borrowers: llmResult.borrowers,
              applications: llmResult.applications,
              missing_fields: llmResult.missing_fields,
            },
          };

          await extractPdfQueue.add('extract_pdf', fallbackPayload, {
            jobId: `pdf_${source_system}_${document_id.replace(':', '_')}`,
          });

          logger.info('Enqueued extract_pdf fallback', { document_id });
          return;
        }

        // Step 6: Check if PDF fallback is needed
        if (needsPdfFallback(llmResult)) {
          logger.info('Text extraction incomplete, falling back to PDF', {
            document_id,
            missing_fields: llmResult.missing_fields,
            borrower_count: llmResult.borrowers.length,
          });

          const fallbackPayload: ExtractPdfJob = {
            ...job.data,
            text_extraction_result: {
              borrowers: llmResult.borrowers,
              applications: llmResult.applications,
              missing_fields: llmResult.missing_fields,
            },
          };

          await extractPdfQueue.add('extract_pdf', fallbackPayload, {
            jobId: `pdf_${source_system}_${document_id.replace(':', '_')}`,
          });

          return;
        }

        // Step 7: Enqueue persist_records
        const persistPayload: PersistRecordsJob = {
          event_type: 'extraction.complete',
          correlation_id,
          extraction_result: extractionResult,
        };

        await persistRecordsQueue.add('persist_records', persistPayload, {
          jobId: `persist_${source_system}_${document_id.replace(':', '_')}`,
        });

        logger.info('Enqueued persist_records', {
          document_id,
          borrower_count: extractionResult.borrowers.length,
          application_count: extractionResult.applications.length,
        });

        // Record metrics
        const duration = (Date.now() - startTime) / 1000;
        jobsProcessedCounter.inc({ queue: QUEUE_NAMES.EXTRACT_TEXT, status: 'success' });
        jobDurationHistogram.observe({ queue: QUEUE_NAMES.EXTRACT_TEXT, status: 'success' }, duration);
        extractionDurationHistogram.observe({ extraction_mode: 'text' }, duration);
        documentsProcessedCounter.inc({
          source_system,
          extraction_mode: 'text',
          status: 'success',
        });
      } catch (error) {
        jobsProcessedCounter.inc({ queue: QUEUE_NAMES.EXTRACT_TEXT, status: 'failed' });
        documentsProcessedCounter.inc({
          source_system,
          extraction_mode: 'text',
          status: 'error',
        });
        throw error;
      }
    }
  );
}

// Create and start the worker
const worker = createWorker<ExtractTextJob, void>(QUEUE_NAMES.EXTRACT_TEXT, processExtractText);

logger.info('Text extractor worker started');

// Graceful shutdown
async function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);
  await worker.close();
  await extractPdfQueue.close();
  await persistRecordsQueue.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
