/**
 * Bank Statement Extraction Template
 *
 * Document semantics:
 * - Extract ONLY the account holder's mailing address
 * - Do NOT extract account numbers (they are not loan numbers)
 * - Do NOT extract the bank's address
 * - Joint accounts: all account holders share the address
 */

import type { ExtractionTemplate } from './types';

export const BANK_STATEMENT_TEMPLATE: ExtractionTemplate = {
  documentType: 'bank_statement',
  description: 'Bank statement - extracts account holder mailing address only',

  systemPrompt: `You are a document extraction specialist for bank statements.

WHAT TO EXTRACT:
- address - The account holder's mailing address ONLY

WHAT NOT TO EXTRACT:
- Do NOT extract account numbers (they are NOT loan numbers)
- Do NOT extract the bank's corporate address
- Do NOT extract any loan_number facts

DOCUMENT STRUCTURE:
1. BANK HEADER: Bank name, logo, bank address - IGNORE the bank address
2. ACCOUNT HOLDER SECTION: Account holder name(s), mailing address - EXTRACT this address
3. STATEMENT BODY: Transactions, balances - IGNORE

For joint accounts, ALL account holders share the mailing address with proximity_score: 3.

VALUE OBJECT FORMAT:
{
  "address": { "street1": "<street>", "street2": "", "city": "<city>", "state": "<ST>", "zip": "<zip>" },
  "string_value": "",
  "income": { "amount": 0, "currency": "USD", "frequency": "annual", "period": { "year": 1900, "start_date": "", "end_date": "" }, "employer": "", "source_type": "other" }
}

evidence_source_context: Use "bank_statement_account_holder_address_block"
proximity_score: ALL account holders get proximity_score: 3

Data formats: Names "First Last", ZIP 5 or 9 digits, state 2-letter.`,

  userPromptTemplate: `Extract the account holder mailing address from this bank statement.

DOCUMENT METADATA (use these exact values in all evidence):
- document_id: {{document_id}}
- source_filename: {{source_filename}}

EXTRACT ONLY:
- address - Account holder mailing address (NOT the bank's address)

DO NOT EXTRACT:
- Account numbers (they are NOT loan numbers)
- Bank's corporate address

For joint accounts, include ALL account holder names in names_in_proximity with proximity_score: 3.

DOCUMENT TEXT BY PAGE:
{{page_text}}

Return a facts array with exactly 1 address fact.`,
};
