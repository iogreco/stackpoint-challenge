/**
 * Base Document Extractor
 *
 * Abstract base class providing common functionality for document extractors.
 * Includes LLM extraction as fallback for algorithmic extractors.
 */

import type { DocumentType, DocumentInfo, Fact } from '../types';
import type { ExtractionTemplate } from '../templates/types';
import type {
  DocumentExtractor,
  ExtractionStrategy,
  ExtractionContext,
  ExtractorResult,
  ExtractorMetadata,
} from './types';
import type { PageText } from './llm-extraction';
import { extractWithLlmTemplate } from './llm-extraction';
import { logger } from '../logger';

/**
 * Abstract base class for document extractors.
 * Provides common functionality and LLM fallback.
 */
export abstract class BaseExtractor implements DocumentExtractor {
  abstract readonly documentType: DocumentType;
  abstract readonly description: string;
  abstract readonly strategy: ExtractionStrategy;

  /**
   * Get the LLM template for this document type.
   * Must be implemented by subclasses.
   */
  abstract getTemplate(): ExtractionTemplate;

  /**
   * Extract facts from document pages.
   * Routes to appropriate method based on strategy.
   */
  async extract(
    pages: PageText[],
    docInfo: DocumentInfo,
    ctx: ExtractionContext
  ): Promise<ExtractorResult> {
    const startTime = Date.now();

    logger.info('Starting extraction', {
      document_type: this.documentType,
      document_id: docInfo.document_id,
      strategy: this.strategy,
      page_count: pages.length,
    });

    try {
      let result: ExtractorResult;

      switch (this.strategy) {
        case 'skip':
          result = this.extractSkip(docInfo);
          break;

        case 'algorithmic':
          result = await this.extractAlgorithmic(pages, docInfo, ctx);
          break;

        case 'llm_only':
        default:
          result = await this.extractWithLlm(pages, docInfo, ctx);
          break;
      }

      const durationMs = Date.now() - startTime;
      result.metadata.durationMs = durationMs;

      logger.info('Extraction complete', {
        document_type: this.documentType,
        document_id: docInfo.document_id,
        strategy: this.strategy,
        extraction_method: result.extractionMethod,
        fact_count: result.facts.length,
        duration_ms: durationMs,
      });

      return result;
    } catch (error) {
      logger.error('Extraction failed', error, {
        document_type: this.documentType,
        document_id: docInfo.document_id,
        strategy: this.strategy,
      });
      throw error;
    }
  }

  /**
   * Skip extraction - returns empty facts.
   * Used for document types with no extractable borrower data.
   */
  protected extractSkip(docInfo: DocumentInfo): ExtractorResult {
    logger.debug('Skip extraction', {
      document_type: this.documentType,
      document_id: docInfo.document_id,
    });

    return {
      facts: [],
      warnings: [],
      extractionMethod: 'skip',
      metadata: {},
    };
  }

  /**
   * Algorithmic extraction with LLM fallback.
   * Subclasses should override extractAlgorithmicImpl to provide algorithmic extraction.
   */
  protected async extractAlgorithmic(
    pages: PageText[],
    docInfo: DocumentInfo,
    ctx: ExtractionContext
  ): Promise<ExtractorResult> {
    // Try algorithmic extraction first
    const algorithmicResult = await this.extractAlgorithmicImpl(pages, docInfo, ctx);

    if (algorithmicResult && algorithmicResult.facts.length > 0) {
      logger.debug('Algorithmic extraction succeeded', {
        document_type: this.documentType,
        document_id: docInfo.document_id,
        fact_count: algorithmicResult.facts.length,
      });
      return algorithmicResult;
    }

    // Fall back to LLM if algorithmic extraction yields no facts
    logger.info('Algorithmic extraction yielded no facts, falling back to LLM', {
      document_type: this.documentType,
      document_id: docInfo.document_id,
    });

    return this.extractWithLlm(pages, docInfo, ctx);
  }

  /**
   * Algorithmic extraction implementation.
   * Subclasses should override this for algorithmic extraction.
   * Returns null or empty result to trigger LLM fallback.
   */
  protected async extractAlgorithmicImpl(
    _pages: PageText[],
    _docInfo: DocumentInfo,
    _ctx: ExtractionContext
  ): Promise<ExtractorResult | null> {
    // Default: no algorithmic extraction, will fall back to LLM
    return null;
  }

  /**
   * LLM-based extraction using document template.
   */
  protected async extractWithLlm(
    pages: PageText[],
    docInfo: DocumentInfo,
    ctx: ExtractionContext
  ): Promise<ExtractorResult> {
    const template = this.getTemplate();

    const llmResponse = await extractWithLlmTemplate(pages, docInfo, template, {
      apiKey: ctx.openaiApiKey,
      model: ctx.extractionModel,
      timeoutMs: ctx.timeoutMs,
    });

    return {
      facts: llmResponse.facts,
      warnings: llmResponse.warnings,
      extractionMethod: 'llm',
      metadata: {
        model: llmResponse.model,
        requestId: llmResponse.requestId,
        durationMs: llmResponse.durationMs,
      },
    };
  }
}

/**
 * Simple LLM-only extractor that wraps an existing template.
 * Use this for document types that don't need algorithmic extraction.
 */
export class LlmOnlyExtractor extends BaseExtractor {
  readonly documentType: DocumentType;
  readonly description: string;
  readonly strategy: ExtractionStrategy = 'llm_only';

  private template: ExtractionTemplate;

  constructor(template: ExtractionTemplate) {
    super();
    this.documentType = template.documentType;
    this.description = template.description;
    this.template = template;
  }

  getTemplate(): ExtractionTemplate {
    return this.template;
  }
}

/**
 * Skip extractor that returns empty facts.
 * Use for document types with no extractable borrower data.
 */
export class SkipExtractor extends BaseExtractor {
  readonly documentType: DocumentType;
  readonly description: string;
  readonly strategy: ExtractionStrategy = 'skip';

  private template: ExtractionTemplate;

  constructor(template: ExtractionTemplate) {
    super();
    this.documentType = template.documentType;
    this.description = template.description;
    this.template = template;
  }

  getTemplate(): ExtractionTemplate {
    return this.template;
  }
}
