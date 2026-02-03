/**
 * Closing Disclosure Extractor
 *
 * LLM-only extraction for closing disclosure documents.
 */

import { LlmOnlyExtractor } from '../base-extractor';
import { CLOSING_DISCLOSURE_TEMPLATE } from '../../templates/closing-disclosure.template';

/**
 * Closing disclosure extractor using LLM-only strategy.
 * Extracts borrower info, property address, and loan details.
 */
export class ClosingDisclosureExtractor extends LlmOnlyExtractor {
  constructor() {
    super(CLOSING_DISCLOSURE_TEMPLATE);
  }
}

export const closingDisclosureExtractor = new ClosingDisclosureExtractor();
