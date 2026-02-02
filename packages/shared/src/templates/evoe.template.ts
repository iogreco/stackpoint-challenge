/**
 * Employment Verification (EVOE) Extraction Template
 *
 * Document semantics:
 * - Verifies employment for a specific employee
 * - Contains employer information (company responding to verification)
 * - Employee name and employment details belong to the borrower
 */

import type { ExtractionTemplate } from './types';

export const EVOE_TEMPLATE: ExtractionTemplate = {
  documentType: 'evoe',
  description: 'Employment Verification (VOE) - extracts verified employment and income info',

  systemPrompt: `You are a document extraction specialist for Employment Verification (VOE/EVOE) documents.

DOCUMENT STRUCTURE:
1. EMPLOYER/VERIFIER SECTION:
   - Company name (employer being verified)
   - Company address (do NOT extract as borrower address)
   - Contact information

2. EMPLOYEE SECTION:
   - Employee name (the person being verified - this is the BORROWER)
   - Employee address (may or may not be present)
   - Employment dates (start date, current/end date)
   - Position/title

3. INCOME VERIFICATION:
   - Current salary/hourly rate
   - Pay frequency
   - YTD earnings
   - Probability of continued employment

EXTRACTION RULES:
1. The EMPLOYEE is the borrower - extract their information
2. CRITICAL - ADDRESS PROHIBITION:
   - DO NOT extract ANY fact_type: "address" from EVOE documents
   - There should be ZERO address facts in your response
   - Any address visible in the document is the EMPLOYER'S address, NOT the employee's
   - EVOEs verify employment but do NOT contain employee home addresses
   - If you see ANY address, IGNORE IT completely
3. Extract employer_name for income context
4. Extract verified income with source_type: "evoe"
5. All income facts belong to the employee with proximity_score: 3
6. Extract SSN if present (usually partially masked like xxx-xx-5000)

For each fact provide:
- fact_type and value
- evidence with document_id, source_filename, page_number, quote, evidence_source_context
- names_in_proximity: Employee name with proximity_score: 3

evidence_source_context values for EVOE:
- evoe_verification: Employment and income verification sections
- other: Other locations

proximity_score for EVOE:
- Employee name gets proximity_score: 3 for all employee-related facts
- Employer information should have employee with proximity_score: 0 if extracting employer details

value object format: Always include address, string_value, and income. Fill only the relevant one based on fact_type; use empty/defaults for others.
Data formats: Names "First Last", ZIP 5 or 9 digits, SSN XXX-XX-XXXX, dates YYYY-MM-DD, state 2-letter, currency USD.`,

  userPromptTemplate: `Extract facts from this Employment Verification (VOE/EVOE) document.

DOCUMENT METADATA (use these exact values in all evidence):
- document_id: {{document_id}}
- source_filename: {{source_filename}}

IMPORTANT EVOE RULES:
- The EMPLOYEE is the borrower - extract their information
- ABSOLUTELY NO ADDRESS FACTS: Do not include any fact_type: "address" in your response
- Any address in the document is the employer's address - IGNORE IT
- Extract verified income with source_type: "evoe"
- Extract SSN if present
- Extract employer_name
- Employee gets proximity_score: 3 for income/SSN facts

DOCUMENT TEXT BY PAGE:
{{page_text}}

Return a facts array. Each fact must have fact_type, value, evidence (at least one), and names_in_proximity.`,
};
