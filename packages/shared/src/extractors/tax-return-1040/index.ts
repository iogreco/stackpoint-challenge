/**
 * Tax Return 1040 Extractor
 *
 * Algorithmic extraction for IRS Form 1040 tax returns with LLM fallback.
 * - First tries algorithmic extraction for SSN, address, and income
 * - Falls back to LLM only if minimum requirements not met
 * - Minimum requirements: 1 SSN, 1 address, 1 income
 */

import { BaseExtractor } from '../base-extractor';
import type { ExtractionContext, ExtractorResult, ExtractionStrategy } from '../types';
import type { PageText } from '../llm-extraction';
import type { DocumentType, DocumentInfo } from '../../types';
import type { ExtractionTemplate } from '../../templates/types';
import { TAX_RETURN_1040_TEMPLATE } from '../../templates/tax-return-1040.template';
import { parse1040Document, ALGORITHM_VERSION } from './parser';
import { logger } from '../../logger';

/**
 * Minimum requirements for successful algorithmic extraction.
 * If not met, falls back to LLM.
 */
const MIN_REQUIREMENTS = {
  ssn: 1,
  address: 1,
  income: 1,
};

/**
 * Tax Return 1040 Extractor using algorithmic extraction with LLM fallback.
 *
 * The algorithmic approach solves the SSN attribution problem for MFJ returns:
 * - Each SSN is attributed ONLY to its owner (taxpayer or spouse)
 * - Uses Form 1040's fixed field positions for reliable extraction
 * - Falls back to LLM if minimum requirements (1 SSN, 1 address, 1 income) not met
 */
export class TaxReturn1040Extractor extends BaseExtractor {
  readonly documentType: DocumentType = 'tax_return_1040';
  readonly description = 'IRS Form 1040 Tax Return - algorithmic extraction with LLM fallback';
  readonly strategy: ExtractionStrategy = 'algorithmic';

  getTemplate(): ExtractionTemplate {
    return TAX_RETURN_1040_TEMPLATE;
  }

  /**
   * Check if extraction result meets minimum requirements
   */
  private meetsMinimumRequirements(result: ExtractorResult | null): boolean {
    if (!result || result.facts.length === 0) return false;

    const ssnCount = result.facts.filter(f => f.fact_type === 'ssn').length;
    const addressCount = result.facts.filter(f => f.fact_type === 'address').length;
    const incomeCount = result.facts.filter(f => f.fact_type === 'income').length;

    return (
      ssnCount >= MIN_REQUIREMENTS.ssn &&
      addressCount >= MIN_REQUIREMENTS.address &&
      incomeCount >= MIN_REQUIREMENTS.income
    );
  }

  /**
   * Algorithmic extraction for 1040 forms.
   * Uses regex patterns to extract SSNs, names, addresses, and income with proper attribution.
   */
  protected async extractAlgorithmicImpl(
    pages: PageText[],
    docInfo: DocumentInfo,
    _ctx: ExtractionContext
  ): Promise<ExtractorResult | null> {
    logger.info('Attempting algorithmic extraction for 1040', {
      document_id: docInfo.document_id,
      page_count: pages.length,
      algorithm_version: ALGORITHM_VERSION,
    });

    try {
      const { facts, warnings } = parse1040Document(pages, docInfo);

      const ssnCount = facts.filter(f => f.fact_type === 'ssn').length;
      const addressCount = facts.filter(f => f.fact_type === 'address').length;
      const incomeCount = facts.filter(f => f.fact_type === 'income').length;

      logger.info('Algorithmic 1040 extraction result', {
        document_id: docInfo.document_id,
        fact_count: facts.length,
        ssn_facts: ssnCount,
        address_facts: addressCount,
        income_facts: incomeCount,
        warnings: warnings.length,
      });

      const result: ExtractorResult = {
        facts,
        warnings,
        extractionMethod: 'algorithmic',
        metadata: {
          algorithmVersion: ALGORITHM_VERSION,
        },
      };

      // Check if we meet minimum requirements
      if (!this.meetsMinimumRequirements(result)) {
        logger.warn('Algorithmic extraction did not meet minimum requirements, will fallback to LLM', {
          document_id: docInfo.document_id,
          ssn_count: ssnCount,
          address_count: addressCount,
          income_count: incomeCount,
          min_ssn: MIN_REQUIREMENTS.ssn,
          min_address: MIN_REQUIREMENTS.address,
          min_income: MIN_REQUIREMENTS.income,
        });
        return null;
      }

      return result;
    } catch (error) {
      logger.warn('Algorithmic extraction error, will fallback to LLM', {
        document_id: docInfo.document_id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

export const taxReturn1040Extractor = new TaxReturn1040Extractor();

// Re-export patterns and parser for testing
export * from './patterns';
export * from './parser';
