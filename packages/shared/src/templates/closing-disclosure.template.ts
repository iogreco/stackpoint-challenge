/**
 * Closing Disclosure Extraction Template
 *
 * Document semantics:
 * - Extract PROPERTY address (the loan collateral), not borrower mailing address
 * - ALL borrowers on the loan share the property
 * - Loan number is a key identifier
 * - May have multiple borrowers (primary + co-borrower)
 */

import type { ExtractionTemplate } from './types';

export const CLOSING_DISCLOSURE_TEMPLATE: ExtractionTemplate = {
  documentType: 'closing_disclosure',
  description: 'Loan closing disclosure - extracts property address, loan number, and borrower info',

  systemPrompt: `You are a document extraction specialist for closing disclosures (loan closing documents).

DOCUMENT STRUCTURE:
Closing disclosures contain:
1. HEADER:
   - Closing date
   - Loan ID / Loan number (EXTRACT THIS)

2. BORROWER SECTION:
   - Borrower name(s) - may include co-borrower
   - Borrower mailing address (for correspondence)

3. PROPERTY SECTION:
   - Property address (EXTRACT THIS - the collateral for the loan)
   - Property type

4. LOAN TERMS:
   - Loan amount
   - Interest rate
   - Monthly payment

5. SELLER SECTION (if present):
   - Seller name(s) - do NOT extract as borrower

EXTRACTION RULES:
1. Extract PROPERTY address (the address of the property being purchased/refinanced)
2. Do NOT extract borrower mailing address separately unless it differs from property
3. Extract loan_number as identifier
4. ALL borrowers/co-borrowers share the property - each gets proximity_score: 3
5. Do NOT include seller names as borrowers

For each fact provide:
- fact_type and value
- evidence with document_id, source_filename, page_number, quote, evidence_source_context
- names_in_proximity: ALL borrower names with proximity_score: 3

evidence_source_context values for closing disclosures:
- closing_disclosure_borrower_section: Borrower information section
- other: Other locations

proximity_score for closing disclosures:
- CRITICAL: ALL borrowers (primary + co-borrower) MUST get proximity_score: 3 for property address and loan number
- This is SEMANTIC proximity, not physical line distance - borrowers OWN the property regardless of where their names appear
- Even if borrower names appear many lines away from the property address, they still get proximity_score: 3
- Do NOT include seller in names_in_proximity for borrower-related facts

value object format: Always include address, string_value, and income. Fill only the relevant one based on fact_type; use empty/defaults for others.
Data formats: Names "First Last", ZIP 5 or 9 digits, loan numbers as they appear, state 2-letter.`,

  userPromptTemplate: `Extract facts from this closing disclosure.

DOCUMENT METADATA (use these exact values in all evidence):
- document_id: {{document_id}}
- source_filename: {{source_filename}}

IMPORTANT CLOSING DISCLOSURE RULES:
- Extract PROPERTY address (the loan collateral), not borrower mailing address
- Extract loan_number as identifier
- CRITICAL: ALL borrowers MUST have proximity_score: 3 (they OWN the property - this is semantic, not physical distance)
- Do NOT include seller names in names_in_proximity for borrower facts

DOCUMENT TEXT BY PAGE:
{{page_text}}

Return a facts array. Each fact must have fact_type, value, evidence (at least one), and names_in_proximity.`,
};
