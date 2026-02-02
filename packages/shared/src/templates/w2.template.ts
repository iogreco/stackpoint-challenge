/**
 * W-2 (Wage and Tax Statement) Extraction Template
 *
 * Document semantics:
 * - ALL facts belong to the EMPLOYEE (the person receiving the W-2)
 * - Box f contains employee address (extract this)
 * - Box c contains employer name and address (do NOT extract employer address as borrower address)
 * - Box 1 contains wages (frequency: annual)
 * - Box a contains employee SSN
 */

import type { ExtractionTemplate } from './types';

export const W2_TEMPLATE: ExtractionTemplate = {
  documentType: 'w2',
  description: 'IRS Form W-2 Wage and Tax Statement - extracts employee info, wages, and SSN',

  systemPrompt: `You are a document extraction specialist for W-2 (Wage and Tax Statement) forms.

CRITICAL EXTRACTION RULE:
Multiple facts of the same fact_type are expected. Do not stop after finding one. Extract ALL valid instances present in the document.

DOCUMENT STRUCTURE:
- Box a: Employee SSN
- Box b: Employer EIN (do NOT extract as borrower identifier)
- Box c: Employer name and address (do NOT extract as borrower address)
- Box e: Employee name
- Box f: Employee address (EXTRACT THIS as the borrower address)
- Box 1: Wages, tips, other compensation (annual income)
- Box 2: Federal income tax withheld

EXTRACTION RULES:
1. ALL facts belong to the EMPLOYEE (the person named in Box e)
2. Extract employee address from Box f ONLY (NOT employer address from Box c)
3. Extract employer_name from Box c for income context
4. Extract wages from Box 1 with frequency: "annual"
5. Extract SSN from Box a

For each fact provide:
- fact_type and value
- evidence with document_id, source_filename, page_number, quote, evidence_source_context
- names_in_proximity: The employee name with proximity_score 3 (same document section)

evidence_source_context values for W-2:
- w2_employee_ssn: Employee SSN (Box a) - use for SSN facts
- w2_employee_address_block: Employee address (Box f)
- w2_employer_address_block: Employer address (Box c) - use for employer_name facts only
- w2_wages_boxes_annual: Wage boxes (Box 1, etc.)
- other: Other locations

proximity_score for W-2:
- ALL names_in_proximity entries should have proximity_score: 3 (employee owns all facts on their W-2)

value object format: Always include address, string_value, and income. Fill only the relevant one based on fact_type; use empty/defaults for others.
Data formats: Names "First Last", ZIP 5 or 9 digits, SSN XXX-XX-XXXX, dates YYYY-MM-DD, state 2-letter, currency USD.`,

  userPromptTemplate: `Extract facts from this W-2 (Wage and Tax Statement).

DOCUMENT METADATA (use these exact values in all evidence):
- document_id: {{document_id}}
- source_filename: {{source_filename}}

IMPORTANT W-2 RULES:
- Extract EMPLOYEE address from Box f (NOT employer address from Box c)
- ALL facts belong to the employee - use proximity_score: 3 for the employee name
- Extract wages from Box 1 as annual income

DOCUMENT TEXT BY PAGE:
{{page_text}}

Return a facts array. Each fact must have fact_type, value, evidence (at least one), and names_in_proximity.`,
};
