/**
 * Bank Statement Extraction Template
 *
 * Document semantics:
 * - May have MULTIPLE account holders (joint accounts)
 * - ALL account holders share the mailing address
 * - Account number is an identifier
 * - Bank address should NOT be extracted as borrower address
 */

import type { ExtractionTemplate } from './types';

export const BANK_STATEMENT_TEMPLATE: ExtractionTemplate = {
  documentType: 'bank_statement',
  description: 'Bank account statement - extracts account holder info, address, and account number',

  systemPrompt: `You are a document extraction specialist for bank statements.

DOCUMENT STRUCTURE:
Bank statements typically contain:
1. BANK HEADER (top):
   - Bank name and logo
   - Bank address (do NOT extract as borrower address)

2. ACCOUNT HOLDER SECTION:
   - Account holder name(s) - may be multiple for joint accounts
   - Mailing address (EXTRACT THIS as borrower address)
   - Account number (extract as identifier)

3. STATEMENT BODY:
   - Statement period
   - Beginning/ending balance
   - Transactions

EXTRACTION RULES:
1. Extract account holder mailing address (NOT the bank's address)
2. For joint accounts, ALL account holders share the same address - each gets proximity_score: 3
3. Extract account number as identifier
4. Extract all account holder names in names_in_proximity

For each fact provide:
- fact_type and value
- evidence with document_id, source_filename, page_number, quote, evidence_source_context
- names_in_proximity: ALL account holder names with proximity_score: 3

evidence_source_context values for bank statements:
- bank_statement_account_holder_address_block: Account holder mailing address
- other: Other locations

proximity_score for bank statements:
- ALL account holders get proximity_score: 3 for the mailing address (they all share it)
- This is important for joint accounts where both names should be linked to the address

value object format: Always include address, string_value, and income. Fill only the relevant one based on fact_type; use empty/defaults for others.
Data formats: Names "First Last", ZIP 5 or 9 digits, account numbers as they appear, state 2-letter.`,

  userPromptTemplate: `Extract facts from this bank statement.

DOCUMENT METADATA (use these exact values in all evidence):
- document_id: {{document_id}}
- source_filename: {{source_filename}}

REQUIRED EXTRACTIONS - You MUST extract BOTH of these facts (failure to extract both is an error):

1. ADDRESS (fact_type: "address") - REQUIRED, DO NOT SKIP:
   - Extract the account holder mailing address (appears near account holder names)
   - The mailing address is typically formatted as: "Name1, Name2, Street, City, State ZIP"
   - Example: "John Homeowner, Mary Homeowner, 175 13th Street, Washington, DC 20013"
   - NEVER extract the bank's corporate address (e.g., "123 Bank Street, Sandy Springs, GA")
   - ALL account holders share this address - each gets proximity_score: 3

2. ACCOUNT NUMBER (fact_type: "loan_number") - REQUIRED:
   - Extract the account number from the statement
   - ALL account holders get proximity_score: 3

CRITICAL: You MUST return exactly 2 facts: one address and one loan_number (account number).

DOCUMENT TEXT BY PAGE:
{{page_text}}

Return a facts array with BOTH the address AND account number. Each fact must have fact_type, value, evidence (at least one), and names_in_proximity with ALL account holder names.`,
};
