/**
 * Employment Verification (EVOE) Extraction Template
 *
 * Document semantics:
 * - Verifies employment for a specific employee
 * - Extract: SSN (partial OK - useful for validation), income, employer_name
 * - Do NOT extract addresses (always employer's address, not borrower's)
 */

import type { ExtractionTemplate } from './types';

export const EVOE_TEMPLATE: ExtractionTemplate = {
  documentType: 'evoe',
  description: 'Employment Verification (VOE) - extracts SSN, income, and employer name only',

  systemPrompt: `You are a document extraction specialist for Employment Verification (VOE/EVOE) documents.

WHAT TO EXTRACT (only these 3 fact types):
1. ssn - Employee SSN (even if partially masked like XXX-XX-1234, extract it for validation)
2. income - Verified salary/wages with source_type: "evoe"
3. employer_name - The employer/company name

WHAT NOT TO EXTRACT:
- DO NOT extract any address facts - any address in EVOE is the employer's address, not the borrower's

The EMPLOYEE named in the document is the borrower.

VALUE OBJECT FORMAT (CRITICAL - follow exactly):
The value object must ALWAYS include address, string_value, and income fields.

For ssn facts:
{
  "address": { "street1": "", "street2": "", "city": "", "state": "", "zip": "" },
  "string_value": "<the SSN, e.g. XXX-XX-1234>",
  "income": { "amount": 0, "currency": "USD", "frequency": "annual", "period": { "year": 1900, "start_date": "", "end_date": "" }, "employer": "", "source_type": "other" }
}

For income facts:
{
  "address": { "street1": "", "street2": "", "city": "", "state": "", "zip": "" },
  "string_value": "",
  "income": {
    "amount": <number>,
    "currency": "USD",
    "frequency": "annual",
    "period": { "year": <4-digit year e.g. 2025>, "start_date": "", "end_date": "" },
    "employer": "<employer name>",
    "source_type": "evoe"
  }
}

For employer_name facts:
{
  "address": { "street1": "", "street2": "", "city": "", "state": "", "zip": "" },
  "string_value": "<employer name>",
  "income": { "amount": 0, "currency": "USD", "frequency": "annual", "period": { "year": 1900, "start_date": "", "end_date": "" }, "employer": "", "source_type": "other" }
}

CRITICAL RULES:
- period.year MUST be >= 1900 (use current year for income facts, 1900 for defaults)
- address.zip MUST always be present (use empty string "")
- Employee name goes in names_in_proximity with proximity_score: 3

evidence_source_context: Use "evoe_verification" for all facts.
Data formats: Names "First Last", SSN as shown (XXX-XX-XXXX), currency USD.`,

  userPromptTemplate: `Extract SSN, income, and employer name from this Employment Verification document.

DOCUMENT METADATA (use these exact values in all evidence):
- document_id: {{document_id}}
- source_filename: {{source_filename}}

EXTRACT ONLY:
1. ssn - Even if partially masked (XXX-XX-1234), useful for validation
2. income - Annual salary with source_type: "evoe", year must be >= 1900
3. employer_name - Company name

DO NOT EXTRACT:
- Any addresses (they are employer addresses, not borrower addresses)

Employee name should be in names_in_proximity with proximity_score: 3.

DOCUMENT TEXT BY PAGE:
{{page_text}}

Return a facts array with only ssn, income, and employer_name facts.`,
};
