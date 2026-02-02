/**
 * Document Classification
 *
 * Fast classification step to identify document type before extraction.
 * Uses a lightweight model (gpt-5-nano) for quick classification.
 */

import type { DocumentType } from '../types';

/**
 * System prompt for document classification.
 * Designed for fast, accurate document type identification.
 */
export const CLASSIFICATION_SYSTEM_PROMPT = `You are a document classifier for loan application documents.
Identify the document type from the text preview provided.

Document types:
- w2: IRS Form W-2 (Wage and Tax Statement). Contains boxes labeled 1-20, employer EIN, employee SSN, annual wages.
- paystub: Pay stub / earnings statement. Shows pay period, gross pay, deductions, YTD totals, employer name in header.
- bank_statement: Bank account statement. Shows account number, transactions, beginning/ending balance, bank name.
- closing_disclosure: Loan closing disclosure. Shows loan terms, closing costs, property address, borrower/seller info.
- tax_return_1040: IRS Form 1040 tax return. Shows filing status, income, deductions, tax calculations.
- evoe: Employment Verification (VOE). Employer verification of employment dates, salary, position.
- transmittal_summary: Uniform Underwriting and Transmittal Summary (Form 1008). Contains subject property info, loan summary, borrower names. Shows "Uniform Underwriting and Transmittal Summary" or "Form 1008" in header.
- unknown: Cannot determine document type from preview.

Return the most likely document type and your confidence (0-1).`;

/**
 * User prompt template for classification.
 * {{preview}} will be replaced with the first ~2000 characters of document text.
 */
export const CLASSIFICATION_USER_PROMPT_TEMPLATE = `Classify this loan document based on the preview:

DOCUMENT PREVIEW:
{{preview}}

Return the document type and confidence.`;

/**
 * JSON Schema for classification response (OpenAI Structured Outputs)
 */
export const CLASSIFICATION_SCHEMA = {
  name: 'document_classification',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['document_type', 'confidence', 'reasoning'],
    properties: {
      document_type: {
        type: 'string',
        enum: ['w2', 'paystub', 'bank_statement', 'closing_disclosure', 'tax_return_1040', 'evoe', 'transmittal_summary', 'unknown'],
        description: 'The identified document type',
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Confidence score from 0 to 1',
      },
      reasoning: {
        type: 'string',
        description: 'Brief explanation for the classification',
      },
    },
  },
} as const;

/**
 * Document type display names for logging
 */
export const DOCUMENT_TYPE_NAMES: Record<DocumentType, string> = {
  w2: 'W-2 (Wage and Tax Statement)',
  paystub: 'Pay Stub',
  bank_statement: 'Bank Statement',
  closing_disclosure: 'Closing Disclosure',
  tax_return_1040: 'Tax Return (1040)',
  evoe: 'Employment Verification',
  transmittal_summary: 'Uniform Underwriting and Transmittal Summary (Form 1008)',
  unknown: 'Unknown Document',
};
