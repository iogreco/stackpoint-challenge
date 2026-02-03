/**
 * Closing Disclosure Extraction Template
 *
 * Document semantics:
 * - Extract ONLY the loan number (Loan ID)
 * - Do NOT extract property address (it's the collateral, not borrower's residence)
 * - Loan number links borrowers to their loan application
 * - May have multiple borrowers (primary + co-borrower)
 */

import type { ExtractionTemplate } from './types';

export const CLOSING_DISCLOSURE_TEMPLATE: ExtractionTemplate = {
  documentType: 'closing_disclosure',
  description: 'Loan closing disclosure - extracts loan number only',

  systemPrompt: `You are a document extraction specialist for closing disclosures (loan closing documents).

EXTRACTION SCOPE - LOAN NUMBER ONLY:
From closing disclosures, extract ONLY the loan number (Loan ID). Do NOT extract addresses or other information.

WHY ONLY LOAN NUMBER:
- The property address in a closing disclosure is the COLLATERAL being purchased/refinanced
- It is NOT the borrower's current residence address
- Extracting it would create incorrect borrower address data
- The loan number is the key identifier that links borrowers to their loan application

DOCUMENT STRUCTURE (for reference):
1. HEADER: Contains Loan ID / Loan number - EXTRACT THIS
2. BORROWER SECTION: Contains borrower names - use for names_in_proximity
3. PROPERTY SECTION: Contains property address - DO NOT EXTRACT
4. SELLER SECTION: Contains seller names - IGNORE

EXTRACTION RULES:
1. Extract ONLY loan_number as a fact
2. Do NOT extract any addresses
3. ALL borrowers/co-borrowers listed should be in names_in_proximity with proximity_score: 3
4. Do NOT include seller names in names_in_proximity

For the loan_number fact provide:
- fact_type: "loan_number"
- value: { string_value: "<the loan number>", address: {empty}, income: {defaults} }
- evidence with document_id, source_filename, page_number, quote, evidence_source_context
- names_in_proximity: ALL borrower names with proximity_score: 3

evidence_source_context: Use "closing_disclosure_borrower_section" or "other"

value object format: Always include address, string_value, and income. For loan_number, fill string_value; use empty/defaults for others.
Data formats: Names "First Last", loan numbers as they appear.`,

  userPromptTemplate: `Extract the loan number from this closing disclosure.

DOCUMENT METADATA (use these exact values in all evidence):
- document_id: {{document_id}}
- source_filename: {{source_filename}}

CRITICAL RULES:
- Extract ONLY the loan number (Loan ID) - nothing else
- Do NOT extract any addresses (property address is collateral, not borrower residence)
- Include ALL borrower names (not seller) in names_in_proximity with proximity_score: 3

DOCUMENT TEXT BY PAGE:
{{page_text}}

Return a facts array with ONLY the loan_number fact.`,
};
