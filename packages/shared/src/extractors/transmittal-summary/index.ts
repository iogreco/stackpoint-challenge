/**
 * Transmittal Summary Extractor
 *
 * LLM-only extraction for Form 1008 transmittal summary documents.
 */

import { LlmOnlyExtractor } from '../base-extractor';
import { TRANSMITTAL_SUMMARY_TEMPLATE } from '../../templates/transmittal-summary.template';

/**
 * Transmittal summary extractor using LLM-only strategy.
 * Extracts borrower SSNs and loan numbers.
 * Note: Does NOT extract addresses (property address shown is subject property).
 */
export class TransmittalSummaryExtractor extends LlmOnlyExtractor {
  constructor() {
    super(TRANSMITTAL_SUMMARY_TEMPLATE);
  }
}

export const transmittalSummaryExtractor = new TransmittalSummaryExtractor();
