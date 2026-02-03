/**
 * EVOE (Employment Verification) Extractor
 *
 * LLM-only extraction for employment verification documents.
 */

import { LlmOnlyExtractor } from '../base-extractor';
import { EVOE_TEMPLATE } from '../../templates/evoe.template';

/**
 * EVOE extractor using LLM-only strategy.
 * Extracts verified employment and income information.
 * Note: Does NOT extract addresses (employer address only).
 */
export class EvoeExtractor extends LlmOnlyExtractor {
  constructor() {
    super(EVOE_TEMPLATE);
  }
}

export const evoeExtractor = new EvoeExtractor();
