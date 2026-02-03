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
export {
  validateExtraction,
  validateBorrower,
  validateApplication,
  schemas,
} from './schemas';

// Templates (two-step extraction)
export {
  getTemplateForDocumentType,
  getAvailableDocumentTypes,
  CLASSIFICATION_SYSTEM_PROMPT,
  CLASSIFICATION_USER_PROMPT_TEMPLATE,
  CLASSIFICATION_SCHEMA,
  DOCUMENT_TYPE_NAMES,
  W2_TEMPLATE,
  PAYSTUB_TEMPLATE,
  BANK_STATEMENT_TEMPLATE,
  CLOSING_DISCLOSURE_TEMPLATE,
  TAX_RETURN_1040_TEMPLATE,
  EVOE_TEMPLATE,
  TRANSMITTAL_SUMMARY_TEMPLATE,
  LETTER_OF_EXPLANATION_TEMPLATE,
  TITLE_REPORT_TEMPLATE,
  UNKNOWN_TEMPLATE,
  type ExtractionTemplate,
  type ClassificationResult,
} from './templates';

// Document Extractors (modular extraction architecture)
export {
  // Types
  type DocumentExtractor,
  type ExtractionStrategy,
  type ExtractionContext,
  type ExtractorResult,
  type ExtractorMetadata,
  type PageText,
  type LlmExtractionOptions,
  type LlmExtractionResponse,
  // Base classes
  BaseExtractor,
  LlmOnlyExtractor,
  SkipExtractor,
  // Registry
  registerExtractor,
  getExtractor,
  getExtractorOrThrow,
  hasExtractor,
  getRegisteredTypes,
  getAllExtractors,
  clearRegistry,
  getRegistryStats,
  registerAllExtractors,
  // LLM utilities
  formatPageText,
  formatPageTextWithLimit,
  prioritizePages,
  normalizeLlmFacts,
  extractWithLlmTemplate,
  // Extractors
  paystubExtractor,
  bankStatementExtractor,
  closingDisclosureExtractor,
  evoeExtractor,
  transmittalSummaryExtractor,
  letterOfExplanationExtractor,
  w2Extractor,
  unknownExtractor,
  titleReportExtractor,
  taxReturn1040Extractor,
  // 1040 algorithmic exports for testing
  extractPrimaryTaxpayerSSN,
  extractSpouseSSN,
  extractPrimaryTaxpayerName,
  extractSpouseName,
  extractAddress,
  extractTaxYear,
  isMarriedFilingJointly,
  parse1040HeaderPage,
  parse1040Document,
  findHeaderPages,
  formatSSN,
  normalizeSSN,
  ALGORITHM_VERSION,
} from './extractors';
