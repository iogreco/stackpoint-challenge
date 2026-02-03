/**
 * Letter of Explanation Extractor
 *
 * LLM-only extraction for letter of explanation documents.
 */

import { LlmOnlyExtractor } from '../base-extractor';
import { LETTER_OF_EXPLANATION_TEMPLATE } from '../../templates/letter-of-explanation.template';

/**
 * Letter of explanation extractor using LLM-only strategy.
 * Extracts borrower address if clearly present.
 * Note: Does NOT extract employer_name, income, SSN, or loan_number.
 */
export class LetterOfExplanationExtractor extends LlmOnlyExtractor {
  constructor() {
    super(LETTER_OF_EXPLANATION_TEMPLATE);
  }
}

export const letterOfExplanationExtractor = new LetterOfExplanationExtractor();
