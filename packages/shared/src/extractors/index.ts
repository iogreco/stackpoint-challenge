/**
 * Document Extractors Module
 *
 * Modular document extractor architecture where each document type
 * has its own extractor with appropriate extraction strategy.
 *
 * Strategies:
 * - 'algorithmic': Pattern-based extraction with LLM fallback (1040)
 * - 'llm_only': Pure LLM extraction (most document types)
 * - 'skip': Returns empty facts (title reports)
 */

// Core types and interfaces
export type {
  DocumentExtractor,
  ExtractionStrategy,
  ExtractionContext,
  ExtractorResult,
  ExtractorMetadata,
  PageText,
} from './types';

// Base classes
export { BaseExtractor, LlmOnlyExtractor, SkipExtractor } from './base-extractor';

// Registry
export {
  registerExtractor,
  getExtractor,
  getExtractorOrThrow,
  hasExtractor,
  getRegisteredTypes,
  getAllExtractors,
  clearRegistry,
  getRegistryStats,
} from './registry';

// LLM extraction utilities
export {
  formatPageText,
  formatPageTextWithLimit,
  prioritizePages,
  normalizeLlmFacts,
  extractWithLlmTemplate,
  type LlmExtractionOptions,
  type LlmExtractionResponse,
  type LlmExtractionResult,
} from './llm-extraction';

// Individual extractors
export { PaystubExtractor, paystubExtractor } from './paystub';
export { BankStatementExtractor, bankStatementExtractor } from './bank-statement';
export { ClosingDisclosureExtractor, closingDisclosureExtractor } from './closing-disclosure';
export { EvoeExtractor, evoeExtractor } from './evoe';
export { TransmittalSummaryExtractor, transmittalSummaryExtractor } from './transmittal-summary';
export { LetterOfExplanationExtractor, letterOfExplanationExtractor } from './letter-of-explanation';
export { W2Extractor, w2Extractor } from './w2';
export { UnknownExtractor, unknownExtractor } from './unknown';
export { TitleReportExtractor, titleReportExtractor } from './title-report';
export {
  TaxReturn1040Extractor,
  taxReturn1040Extractor,
  // Re-export patterns for testing
  extractPrimaryTaxpayerSSN,
  extractSpouseSSN,
  extractPrimaryTaxpayerName,
  extractSpouseName,
  extractAddress,
  extractTaxYear,
  isMarriedFilingJointly,
  parse1040HeaderPage,
  formatSSN,
  normalizeSSN,
  // Parser exports
  parse1040Document,
  findHeaderPages,
  ALGORITHM_VERSION,
} from './tax-return-1040';

// Import for registration
import { registerExtractor } from './registry';
import { paystubExtractor } from './paystub';
import { bankStatementExtractor } from './bank-statement';
import { closingDisclosureExtractor } from './closing-disclosure';
import { evoeExtractor } from './evoe';
import { transmittalSummaryExtractor } from './transmittal-summary';
import { letterOfExplanationExtractor } from './letter-of-explanation';
import { w2Extractor } from './w2';
import { unknownExtractor } from './unknown';
import { titleReportExtractor } from './title-report';
import { taxReturn1040Extractor } from './tax-return-1040';

/**
 * Register all built-in extractors.
 * Call this at application startup.
 */
export function registerAllExtractors(): void {
  registerExtractor(paystubExtractor);
  registerExtractor(bankStatementExtractor);
  registerExtractor(closingDisclosureExtractor);
  registerExtractor(evoeExtractor);
  registerExtractor(transmittalSummaryExtractor);
  registerExtractor(letterOfExplanationExtractor);
  registerExtractor(w2Extractor);
  registerExtractor(unknownExtractor);
  registerExtractor(titleReportExtractor);
  registerExtractor(taxReturn1040Extractor);
}

// Auto-register all extractors on module load
registerAllExtractors();
