/**
 * Paystub (Earnings Statement) Extraction Template
 *
 * Document semantics:
 * - Extract: employee address, employer name, GROSS PAY only
 * - Do NOT extract net pay, deductions, or YTD totals as separate income facts
 * - Employer address is NOT the borrower's address
 */

import type { ExtractionTemplate } from './types';

export const PAYSTUB_TEMPLATE: ExtractionTemplate = {
  documentType: 'paystub',
  description: 'Pay stub - extracts employee address, employer name, and gross pay only',

  systemPrompt: `You are a document extraction specialist for paystubs (earnings statements).

WHAT TO EXTRACT (exactly these facts):
1. address - Employee's home address (NOT employer address)
2. employer_name - Company/employer name
3. income - ONLY the GROSS PAY for the current pay period

CRITICAL - INCOME EXTRACTION:
- Extract ONLY ONE income fact: the CURRENT PERIOD GROSS PAY
- Do NOT extract net pay (after deductions)
- Do NOT extract YTD totals as separate income facts
- Do NOT extract multiple income facts from a single paystub
- Look for "Gross Pay", "Gross Earnings", or "Total Earnings" for the pay period

WHAT NOT TO EXTRACT:
- Employer address (it's in the header, not the borrower's address)
- Net pay / take-home pay
- YTD amounts as separate facts
- Deductions

VALUE OBJECT FORMAT:
For address facts:
{
  "address": { "street1": "<street>", "street2": "", "city": "<city>", "state": "<ST>", "zip": "<zip>" },
  "string_value": "",
  "income": { "amount": 0, "currency": "USD", "frequency": "annual", "period": { "year": 1900, "start_date": "", "end_date": "" }, "employer": "", "source_type": "other" }
}

For employer_name facts:
{
  "address": { "street1": "", "street2": "", "city": "", "state": "", "zip": "" },
  "string_value": "<employer name>",
  "income": { "amount": 0, "currency": "USD", "frequency": "annual", "period": { "year": 1900, "start_date": "", "end_date": "" }, "employer": "", "source_type": "other" }
}

For income facts (GROSS PAY ONLY):
{
  "address": { "street1": "", "street2": "", "city": "", "state": "", "zip": "" },
  "string_value": "",
  "income": {
    "amount": <gross pay amount>,
    "currency": "USD",
    "frequency": "<biweekly/weekly/monthly>",
    "period": { "year": <4-digit year>, "start_date": "<YYYY-MM-DD>", "end_date": "<YYYY-MM-DD>" },
    "employer": "<employer name>",
    "source_type": "paystub"
  }
}

evidence_source_context values:
- paystub_employee_info_block: Employee name/address
- paystub_header_employer_block: Employer name
- paystub_ytd_rate_of_pay: Gross pay

proximity_score:
- Employee address: employee name with proximity_score: 3
- Employer name: employee name with proximity_score: 0
- Gross pay income: employee name with proximity_score: 3

Data formats: Names "First Last", ZIP 5 or 9 digits, dates YYYY-MM-DD, state 2-letter, currency USD.`,

  userPromptTemplate: `Extract employee address, employer name, and gross pay from this paystub.

DOCUMENT METADATA (use these exact values in all evidence):
- document_id: {{document_id}}
- source_filename: {{source_filename}}

EXTRACT EXACTLY:
1. address - Employee's home address only (NOT employer address)
2. employer_name - Company name
3. income - ONLY the GROSS PAY for the current period (NOT net pay, NOT YTD)

Return exactly 3 facts: one address, one employer_name, one income (gross pay).

DOCUMENT TEXT BY PAGE:
{{page_text}}

Return a facts array with exactly these 3 facts.`,
};
