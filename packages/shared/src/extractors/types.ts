/**
 * Document Extractor Types
 *
 * Defines interfaces for the modular document extractor architecture.
 * Each document type gets its own extractor that can use algorithmic
 * extraction (for structured forms) with LLM fallback, or LLM-only extraction.
 */

import type {
  DocumentType,
  DocumentInfo,
  Fact,
  Evidence,
  NameInProximity,
} from '../types';
import type { ExtractionTemplate } from '../templates/types';
import type { PageText } from './llm-extraction';

/**
 * Extraction strategy determines how facts are extracted:
 * - 'algorithmic': Pattern-based extraction with LLM fallback
 * - 'llm_only': Pure LLM extraction using document template
 * - 'skip': Returns empty facts (for documents with no extractable borrower data)
 */
export type ExtractionStrategy = 'algorithmic' | 'llm_only' | 'skip';

/**
 * Context passed to extractors during extraction
 */
export interface ExtractionContext {
  /** Correlation ID for tracing */
  correlationId: string;
  /** OpenAI API key (optional, uses env var if not provided) */
  openaiApiKey?: string;
  /** LLM model to use for extraction */
  extractionModel?: string;
  /** Request timeout in milliseconds */
  timeoutMs?: number;
}

/**
 * Result returned by an extractor
 */
export interface ExtractorResult {
  /** Extracted facts */
  facts: Fact[];
  /** Warnings generated during extraction */
  warnings: string[];
  /** How extraction was performed */
  extractionMethod: 'algorithmic' | 'llm' | 'skip';
  /** Metadata about the extraction */
  metadata: ExtractorMetadata;
}

/**
 * Metadata about an extraction operation
 */
export interface ExtractorMetadata {
  /** LLM model used (if any) */
  model?: string;
  /** LLM request ID (if any) */
  requestId?: string;
  /** Algorithm version (for algorithmic extraction) */
  algorithmVersion?: string;
  /** Duration of extraction in milliseconds */
  durationMs?: number;
  /** Whether hybrid extraction was used (algorithmic + LLM) */
  hybridExtraction?: boolean;
}

/**
 * Interface for document-specific extractors.
 * Each document type implements this interface.
 */
export interface DocumentExtractor {
  /** The document type this extractor handles */
  readonly documentType: DocumentType;

  /** Human-readable description of what this extractor does */
  readonly description: string;

  /** Extraction strategy used by this extractor */
  readonly strategy: ExtractionStrategy;

  /**
   * Extract facts from document pages.
   *
   * @param pages - Extracted text by page
   * @param docInfo - Document metadata
   * @param ctx - Extraction context
   * @returns Extraction result with facts and metadata
   */
  extract(
    pages: PageText[],
    docInfo: DocumentInfo,
    ctx: ExtractionContext
  ): Promise<ExtractorResult>;

  /**
   * Get the LLM template for this document type.
   * Used for LLM extraction or fallback.
   */
  getTemplate(): ExtractionTemplate;
}

/**
 * Re-export PageText for convenience
 */
export type { PageText };

/**
 * Re-export Evidence and NameInProximity for extractor implementations
 */
export type { Evidence, NameInProximity, Fact, DocumentInfo };
