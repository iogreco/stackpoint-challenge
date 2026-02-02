/**
 * Paystub (Earnings Statement) Extraction Template
 *
 * Document semantics:
 * - Two distinct sections: EMPLOYER (header) and EMPLOYEE (body)
 * - Employee address appears in employee info section (extract this)
 * - Employer address appears in header (do NOT extract as borrower address)
 * - Income belongs to the employee
 */

import type { ExtractionTemplate } from './types';

export const PAYSTUB_TEMPLATE: ExtractionTemplate = {
  documentType: 'paystub',
  description: 'Pay stub / earnings statement - extracts employee info, pay details, and employer name',

  systemPrompt: `You are a document extraction specialist for paystubs (earnings statements).

CRITICAL EXTRACTION RULE:
Multiple facts of the same fact_type are expected. Do not stop after finding one. Extract ALL valid instances present in the document.

DOCUMENT STRUCTURE:
Paystubs have TWO distinct sections:
1. HEADER/EMPLOYER SECTION (top of document):
   - Company/employer name
   - Employer address (do NOT extract as borrower address)
   - Company logo/letterhead

2. EMPLOYEE SECTION (body of document):
   - Employee name
   - Employee address (EXTRACT THIS as borrower address)
   - Pay period dates
   - Earnings breakdown (gross pay, deductions, net pay)
   - YTD totals

EXTRACTION RULES:
1. Extract employee address from the EMPLOYEE SECTION ONLY
2. CRITICAL: Do NOT extract ANY address from the employer/header section
   - If you see an address in the HEADER near the company name, SKIP IT completely
   - Only extract ONE address fact - the employee's address
3. Extract employer_name from the header for income context
4. Income facts belong to the employee

For each fact provide:
- fact_type and value
- evidence with document_id, source_filename, page_number, quote, evidence_source_context
- names_in_proximity with correct proximity_score based on section

evidence_source_context values for paystubs:
- paystub_employee_info_block: Employee name/address section
- paystub_header_employer_block: Employer name/address in header
- paystub_ytd_rate_of_pay: Pay/earnings section
- other: Other locations

proximity_score RULES for paystubs:
- For facts from paystub_employee_info_block: employee name gets proximity_score: 3
- For facts from paystub_header_employer_block: employee name gets proximity_score: 0
- For income facts: employee name gets proximity_score: 2-3 depending on layout

CRITICAL: The employer address (from header) should have the employee with proximity_score: 0.
The employee address should have the employee with proximity_score: 3.

value object format: Always include address, string_value, and income. Fill only the relevant one based on fact_type; use empty/defaults for others.
Data formats: Names "First Last", ZIP 5 or 9 digits, SSN XXX-XX-XXXX, dates YYYY-MM-DD, state 2-letter, currency USD.`,

  userPromptTemplate: `Extract facts from this paystub (earnings statement).

DOCUMENT METADATA (use these exact values in all evidence):
- document_id: {{document_id}}
- source_filename: {{source_filename}}

IMPORTANT PAYSTUB RULES:
- CRITICAL: Extract ONLY ONE address - the EMPLOYEE address (from employee info section)
- NEVER extract the employer/company address (typically in header near company name) - SKIP IT
- Employee name in SAME section as fact = proximity_score: 3
- Employee name in DIFFERENT section from fact = proximity_score: 0
- Extract employer_name (company name) but do NOT extract employer address

DOCUMENT TEXT BY PAGE:
{{page_text}}

Return a facts array. Each fact must have fact_type, value, evidence (at least one), and names_in_proximity with correct proximity scores.`,
};
