/**
 * Bank Statement Extractor
 *
 * LLM-only extraction for bank statement documents.
 */

import { LlmOnlyExtractor } from '../base-extractor';
import { BANK_STATEMENT_TEMPLATE } from '../../templates/bank-statement.template';

/**
 * Bank statement extractor using LLM-only strategy.
 * Extracts account holder info and addresses.
 */
export class BankStatementExtractor extends LlmOnlyExtractor {
  constructor() {
    super(BANK_STATEMENT_TEMPLATE);
  }
}

export const bankStatementExtractor = new BankStatementExtractor();
