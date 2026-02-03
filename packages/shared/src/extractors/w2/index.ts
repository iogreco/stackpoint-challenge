/**
 * W2 Extractor
 *
 * LLM-only extraction for W-2 tax form documents.
 * Note: Could be enhanced with algorithmic extraction later.
 */

import { LlmOnlyExtractor } from '../base-extractor';
import { W2_TEMPLATE } from '../../templates/w2.template';

/**
 * W2 extractor using LLM-only strategy.
 * Extracts employee info, SSN, address, wages, and employer.
 */
export class W2Extractor extends LlmOnlyExtractor {
  constructor() {
    super(W2_TEMPLATE);
  }
}

export const w2Extractor = new W2Extractor();
