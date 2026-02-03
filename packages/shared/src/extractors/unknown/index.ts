/**
 * Unknown Document Extractor
 *
 * LLM-only extraction for unknown/unclassified documents.
 */

import { LlmOnlyExtractor } from '../base-extractor';
import { UNKNOWN_TEMPLATE } from '../../templates/unknown.template';

/**
 * Unknown document extractor using LLM-only strategy.
 * Generic extraction for documents that couldn't be classified.
 */
export class UnknownExtractor extends LlmOnlyExtractor {
  constructor() {
    super(UNKNOWN_TEMPLATE);
  }
}

export const unknownExtractor = new UnknownExtractor();
