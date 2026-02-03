/**
 * Paystub Extractor
 *
 * LLM-only extraction for paystub documents.
 */

import { LlmOnlyExtractor } from '../base-extractor';
import { PAYSTUB_TEMPLATE } from '../../templates/paystub.template';

/**
 * Paystub extractor using LLM-only strategy.
 * Extracts employee info, income, and employer details.
 */
export class PaystubExtractor extends LlmOnlyExtractor {
  constructor() {
    super(PAYSTUB_TEMPLATE);
  }
}

export const paystubExtractor = new PaystubExtractor();
