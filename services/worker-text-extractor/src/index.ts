/**
 * Text Extractor Worker
 *
 * Extracts text from PDF, classifies document type, then uses the
 * appropriate extractor from the registry to extract facts.
 * Enqueues persist_records or extract_pdf fallback.
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
  type FactExtractionResult,
  jobsProcessedCounter,
  jobDurationHistogram,
  extractionDurationHistogram,
  documentsProcessedCounter,
  // Extractor registry
  getExtractorOrThrow,
  type ExtractionContext,
} from '@stackpoint/shared';
import { extractTextFromPdf } from './lib/pdf';
import { classifyDocument, type ClassificationWithMetadata } from './lib/llm';

const PROMPT_VERSION = '4.0.0-modular';

// Create queues
const extractPdfQueue = createQueue<ExtractPdfJob, void>(QUEUE_NAMES.EXTRACT_PDF);
const persistRecordsQueue = createQueue<PersistRecordsJob, void>(QUEUE_NAMES.PERSIST_RECORDS);

/**
 * Build FactExtractionResult from extractor output
 */
function buildFactExtractionResult(
  extractorResult: { facts: any[]; warnings: string[]; extractionMethod: string; metadata: any },
  documentInfo: DocumentInfo,
  correlationId: string,
  classification: ClassificationWithMetadata
): FactExtractionResult {
  return {
    schema_version: '2.0',
    correlation_id: correlationId,
    document: documentInfo,
    extraction_mode: 'text',
    facts: extractorResult.facts,
    warnings: extractorResult.warnings,
    extraction_metadata: {
      provider: 'openai',
      model: extractorResult.metadata.model || classification.model,
      request_id: extractorResult.metadata.requestId || `ext_${Date.now()}`,
      prompt_version: PROMPT_VERSION,
      document_type: classification.document_type,
      classification_model: classification.model,
      classification_confidence: classification.confidence,
    },
    created_at: new Date().toISOString(),
  };
}

/**
 * Process extract_text job using modular extractor architecture
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

        // Step 3: Classify document type
        const pageText = pdfResult.pages.map(p => `--- Page ${p.pageNumber} ---\n${p.text}`).join('\n\n');
        const classification = await classifyDocument(pageText, documentInfo);

        logger.info('Document classified, dispatching to extractor', {
          document_id,
          document_type: classification.document_type,
          confidence: classification.confidence,
        });

        // Step 4: Get extractor for document type and extract facts
        const extractor = getExtractorOrThrow(classification.document_type);
        const extractionContext: ExtractionContext = {
          correlationId: correlation_id,
          extractionModel: process.env.LLM_MODEL_TEXT || config.llmModelText,
          timeoutMs: config.llmRequestTimeoutMs,
        };

        const extractorResult = await extractor.extract(
          pdfResult.pages,
          documentInfo,
          extractionContext
        );

        logger.info('Extractor completed', {
          document_id,
          document_type: classification.document_type,
          extraction_method: extractorResult.extractionMethod,
          fact_count: extractorResult.facts.length,
          strategy: extractor.strategy,
        });

        // Step 5: Build fact extraction result
        const factExtractionResult = buildFactExtractionResult(
          extractorResult,
          documentInfo,
          correlation_id,
          classification
        );

        // Step 6: Validate against schema
        const validation = validateExtraction(factExtractionResult);

        if (!validation.valid) {
          logger.warn('Fact extraction validation failed, attempting PDF fallback', {
            errors: validation.errors,
          });

          const fallbackPayload: ExtractPdfJob = {
            ...job.data,
            fact_extraction_result: { facts: extractorResult.facts },
          };

          await extractPdfQueue.add('extract_pdf', fallbackPayload, {
            jobId: `pdf_${source_system}_${document_id.replace(':', '_')}`,
          });

          logger.info('Enqueued extract_pdf fallback', { document_id });
          return;
        }

        // Step 7: Check if PDF fallback is needed (no facts, but not skip strategy)
        if (extractorResult.facts.length === 0 && extractor.strategy !== 'skip') {
          logger.info('Text extraction produced no facts, falling back to PDF', { document_id });

          const fallbackPayload: ExtractPdfJob = {
            ...job.data,
            fact_extraction_result: { facts: extractorResult.facts },
          };

          await extractPdfQueue.add('extract_pdf', fallbackPayload, {
            jobId: `pdf_${source_system}_${document_id.replace(':', '_')}`,
          });

          return;
        }

        // Step 8: Enqueue persist_records
        const persistPayload: PersistRecordsJob = {
          event_type: 'extraction.complete',
          correlation_id,
          extraction_result: factExtractionResult,
        };

        await persistRecordsQueue.add('persist_records', persistPayload, {
          jobId: `persist_${source_system}_${document_id.replace(':', '_')}`,
        });

        logger.info('Enqueued persist_records', {
          document_id,
          fact_count: factExtractionResult.facts.length,
          extraction_method: extractorResult.extractionMethod,
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

logger.info('Text extractor worker started (modular architecture)');

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
