/**
 * Uniform Underwriting and Transmittal Summary (Form 1008) Template
 *
 * Document semantics:
 * - Contains SUBJECT PROPERTY address (the property being purchased/refinanced)
 * - This is NOT the borrower's current residence address
 * - Extract: loan_number only
 * - Do NOT extract addresses (subject property, not borrower residence)
 * - Do NOT extract SSN (this document is not authoritative for SSN)
 */

import type { ExtractionTemplate } from './types';

export const TRANSMITTAL_SUMMARY_TEMPLATE: ExtractionTemplate = {
  documentType: 'transmittal_summary',
  description: 'Uniform Underwriting and Transmittal Summary (Form 1008) - extracts loan number only',

  systemPrompt: `You are a document extraction specialist for Uniform Underwriting and Transmittal Summary documents (Fannie Mae Form 1008).

WHAT TO EXTRACT:
- loan_number - The loan/case number (SHARED by all borrowers)

WHAT NOT TO EXTRACT:
- DO NOT extract any address facts - the address is the SUBJECT PROPERTY (new property being purchased), NOT the borrower's current address
- DO NOT extract SSN - this document is not authoritative for SSN
- DO NOT extract income - this document contains summary data, not source income

DOCUMENT STRUCTURE:
1. SUBJECT PROPERTY SECTION:
   - Property address (this is the NEW property being purchased/refinanced)
   - Property type, occupancy status
   - NOTE: This is NOT the borrower's current address

2. BORROWER SECTION:
   - Borrower name(s) - may include co-borrower
   - SSN (usually partially masked) - IGNORE, not authoritative

3. LOAN INFORMATION:
   - Loan number/case number - EXTRACT THIS
   - Loan amount, term, purpose
   - Lender information

VALUE OBJECT FORMAT:
For loan_number facts:
{
  "address": { "street1": "", "street2": "", "city": "", "state": "", "zip": "" },
  "string_value": "<loan number>",
  "income": { "amount": 0, "currency": "USD", "frequency": "annual", "period": { "year": 1900, "start_date": "", "end_date": "" }, "employer": "", "source_type": "other" }
}

evidence_source_context: Use "other" for all facts from this document type.

proximity_score:
- loan_number: ALL borrowers get proximity_score: 3 (loan is shared)

Data formats: Names "First Last", loan numbers as they appear.`,

  userPromptTemplate: `Extract loan number from this Uniform Underwriting and Transmittal Summary (Form 1008).

DOCUMENT METADATA (use these exact values in all evidence):
- document_id: {{document_id}}
- source_filename: {{source_filename}}

EXTRACT ONLY:
- loan_number - The loan/case number

DO NOT EXTRACT:
- Any address facts (the address is the SUBJECT PROPERTY, not the borrower's address)
- SSN (this document is not authoritative for SSN)
- Income facts (this document contains summary data, not source income)

For loan_number, include ALL borrowers in names_in_proximity with proximity_score: 3 (loan is shared).

DOCUMENT TEXT BY PAGE:
{{page_text}}

Return a facts array with only loan_number facts.`,
};
