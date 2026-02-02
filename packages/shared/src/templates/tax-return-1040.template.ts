/**
 * Tax Return 1040 Extraction Template
 *
 * Document semantics:
 * - ALL facts belong to the TAXPAYER(s)
 * - May have spouse for married filing jointly
 * - Extract taxpayer address from header
 * - Income from various sources (wages, business income, etc.)
 */

import type { ExtractionTemplate } from './types';

export const TAX_RETURN_1040_TEMPLATE: ExtractionTemplate = {
  documentType: 'tax_return_1040',
  description: 'IRS Form 1040 Tax Return - extracts taxpayer info, address, and income',

  systemPrompt: `You are a document extraction specialist for IRS Form 1040 tax returns.

DOCUMENT STRUCTURE:
1. HEADER:
   - Tax year
   - Filing status (single, married filing jointly, etc.)

2. TAXPAYER SECTION:
   - Taxpayer name (and spouse name if MFJ)
   - SSN(s)
   - Address (EXTRACT THIS)

3. INCOME SECTION:
   - Wages, salaries, tips (Line 1)
   - Business income (Schedule C)
   - Other income sources

4. DEDUCTIONS & TAX:
   - Standard/itemized deductions
   - Tax calculations

EXTRACTION RULES:
1. Extract taxpayer address from the header section
2. Extract SSN(s) for taxpayer (and spouse if present)
3. For married filing jointly, BOTH names share the address with proximity_score: 3
4. Extract income with source_type: "tax_return_1040"
5. For Schedule C business income, use evidence_source_context: "tax_return_1040_schedule_c_net_profit"

For each fact provide:
- fact_type and value
- evidence with document_id, source_filename, page_number, quote, evidence_source_context
- names_in_proximity: ALL taxpayer names with proximity_score: 3

evidence_source_context values for tax returns:
- tax_return_1040_taxpayer_address_block: Taxpayer address section
- tax_return_1040_schedule_c_net_profit: Schedule C business income
- other: Other locations

proximity_score for tax returns:
- ALL taxpayers get proximity_score: 3 (they own all facts on their tax return)
- For married filing jointly, both spouses get proximity_score: 3

value object format: Always include address, string_value, and income. Fill only the relevant one based on fact_type; use empty/defaults for others.
Data formats: Names "First Last", ZIP 5 or 9 digits, SSN XXX-XX-XXXX, dates YYYY-MM-DD, state 2-letter, currency USD.`,

  userPromptTemplate: `Extract facts from this IRS Form 1040 tax return.

DOCUMENT METADATA (use these exact values in all evidence):
- document_id: {{document_id}}
- source_filename: {{source_filename}}

IMPORTANT TAX RETURN RULES:
- Extract taxpayer address from the header section
- ALL taxpayers (including spouse if MFJ) get proximity_score: 3
- Extract SSN(s) for each taxpayer
- Income source_type should be "tax_return_1040"

DOCUMENT TEXT BY PAGE:
{{page_text}}

Return a facts array. Each fact must have fact_type, value, evidence (at least one), and names_in_proximity.`,
};
