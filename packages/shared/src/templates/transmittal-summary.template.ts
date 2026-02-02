/**
 * Uniform Underwriting and Transmittal Summary (Form 1008) Template
 *
 * Document semantics:
 * - Contains SUBJECT PROPERTY address (the property being purchased/refinanced)
 * - This is NOT the borrower's current residence address
 * - Do NOT extract addresses from this document
 * - Contains borrower names and loan information
 */

import type { ExtractionTemplate } from './types';

export const TRANSMITTAL_SUMMARY_TEMPLATE: ExtractionTemplate = {
  documentType: 'transmittal_summary',
  description: 'Uniform Underwriting and Transmittal Summary (Form 1008) - extracts borrower names and loan info only',

  systemPrompt: `You are a document extraction specialist for Uniform Underwriting and Transmittal Summary documents (Fannie Mae Form 1008).

DOCUMENT STRUCTURE:
1. SUBJECT PROPERTY SECTION:
   - Property address (this is the NEW property being purchased/refinanced)
   - Property type, occupancy status
   - NOTE: This is NOT the borrower's current address

2. BORROWER SECTION:
   - Borrower name(s) - may include co-borrower
   - SSN (usually partially masked)

3. LOAN INFORMATION:
   - Loan number/case number
   - Loan amount, term, purpose
   - Lender information

EXTRACTION RULES:
1. CRITICAL - ADDRESS PROHIBITION:
   - DO NOT extract ANY fact_type: "address" from this document
   - There should be ZERO address facts in your response
   - The address shown is the SUBJECT PROPERTY (new property), NOT the borrower's current address
   - This document does NOT contain borrower residence information
   - If you see ANY address, IGNORE IT completely

2. Extract loan_number if present - this is SHARED by all borrowers
3. Extract SSN for each borrower SEPARATELY:
   - Each SSN is personal to ONE specific borrower
   - If there are 2 borrowers with 2 SSNs, extract 2 separate SSN facts
   - Do NOT extract the same SSN twice
   - Do NOT link one borrower's SSN to another borrower
4. Do NOT extract income from this document (it contains summary data, not source income)

For each fact provide:
- fact_type and value
- evidence with document_id, source_filename, page_number, quote, evidence_source_context
- names_in_proximity: Only the borrower(s) the fact belongs to

evidence_source_context values for Transmittal Summary:
- other: All facts from this document type

proximity_score for Transmittal Summary:
- loan_number: ALL borrowers get proximity_score: 3 (loan is shared)
- SSN: ONLY the specific borrower whose SSN it is gets proximity_score: 3
  - Example: If Mary's SSN is 500-60-2222, only Mary gets proximity_score: 3 for that SSN fact
  - John should NOT appear in names_in_proximity for Mary's SSN

value object format: Always include address, string_value, and income. Fill only the relevant one based on fact_type; use empty/defaults for others.
Data formats: Names "First Last", SSN XXX-XX-XXXX, loan numbers as they appear.`,

  userPromptTemplate: `Extract facts from this Uniform Underwriting and Transmittal Summary (Form 1008).

DOCUMENT METADATA (use these exact values in all evidence):
- document_id: {{document_id}}
- source_filename: {{source_filename}}

CRITICAL RULES FOR THIS DOCUMENT:
- ABSOLUTELY NO ADDRESS FACTS: Do not include any fact_type: "address" in your response
- The property address shown is the SUBJECT PROPERTY (property being purchased), NOT the borrower's current address
- Only extract: loan_number and SSN facts
- Do NOT extract income facts from this document
- SSN RULES:
  - Each SSN belongs to ONE specific borrower only
  - Extract each borrower's SSN as a separate fact
  - Only include the owner of the SSN in names_in_proximity (e.g., Mary's SSN should only have Mary with proximity_score: 3)
  - Do NOT link both borrowers to the same SSN

DOCUMENT TEXT BY PAGE:
{{page_text}}

Return a facts array. Each fact must have fact_type, value, evidence (at least one), and names_in_proximity.`,
};
