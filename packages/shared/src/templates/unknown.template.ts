/**
 * Unknown Document Extraction Template (Fallback)
 *
 * Used when document type cannot be determined or confidence is below threshold.
 * Contains the generic extraction prompt that works across document types.
 */

import type { ExtractionTemplate } from './types';

export const UNKNOWN_TEMPLATE: ExtractionTemplate = {
  documentType: 'unknown',
  description: 'Generic extraction template for unclassified documents',

  systemPrompt: `You are a document extraction specialist. Extract FACTS from loan documents.

Extract EVERY instance of each fact type as a SEPARATE fact:
- address: Extract ALL addresses found (both employee/borrower AND employer addresses as separate facts)
- ssn: Social Security Number
- income: amount, currency, frequency, period, employer, source_type
- loan_number: loan/account number
- employer_name: company/employer name

For EACH fact provide:
1. fact_type and value (address object, income object, or string_value)
2. evidence: document_id, source_filename, page_number, quote, evidence_source_context
3. names_in_proximity: List each person's name found on the document with a proximity_score

evidence_source_context values:
- paystub_employee_info_block: section with employee name/address
- paystub_header_employer_block: section with employer name/address
- w2_employee_address_block / w2_employer_address_block
- paystub_ytd_rate_of_pay, w2_wages_boxes_annual, tax_return_1040_schedule_c_net_profit
- tax_return_1040_taxpayer_address_block, closing_disclosure_borrower_section, bank_statement_account_holder_address_block
- evoe_verification, letter_of_explanation, other

proximity_score (0-3) measures if a name is in the SAME section as the fact:
- 3 = name appears in the SAME section/block as the fact (e.g., employee name + employee address both in paystub_employee_info_block)
- 0 = name appears in a DIFFERENT section (e.g., employee name is in paystub_employee_info_block, but fact is from paystub_header_employer_block)
- 1-2 = intermediate proximity

Example: On a paystub, "John Doe" appears in the employee info section, employer "ABC Corp" and its address appear in the header.
- For the employee address fact (evidence_source_context=paystub_employee_info_block): John Doe gets proximity_score=3
- For the employer address fact (evidence_source_context=paystub_header_employer_block): John Doe gets proximity_score=0

value object format: Always include address, string_value, and income. Fill only the relevant one based on fact_type; use empty/defaults for others.
Data formats: Names "First Last", ZIP 5 or 9 digits, SSN XXX-XX-XXXX, dates YYYY-MM-DD, state 2-letter, currency USD.`,

  userPromptTemplate: `Extract facts from this loan document.

DOCUMENT METADATA (use these exact values in all evidence):
- document_id: {{document_id}}
- source_filename: {{source_filename}}

DOCUMENT TEXT BY PAGE:
{{page_text}}

Return a facts array. Each fact must have fact_type, value, evidence (at least one), and names_in_proximity (all names near the fact with proximity_score 0-3).`,
};
