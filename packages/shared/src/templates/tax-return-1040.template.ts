/**
 * Tax Return 1040 Extraction Template
 *
 * Document semantics:
 * - ALL facts belong to the TAXPAYER(s)
 * - May have spouse for married filing jointly
 * - Extract taxpayer address from header
 * - Extract Adjusted Gross Income (AGI) from Line 11 only
 */

import type { ExtractionTemplate } from './types';

export const TAX_RETURN_1040_TEMPLATE: ExtractionTemplate = {
  documentType: 'tax_return_1040',
  description: 'IRS Form 1040 Tax Return - extracts taxpayer info, address, and AGI',

  systemPrompt: `You are a document extraction specialist for IRS Form 1040 tax returns.

CRITICAL EXTRACTION RULE:
Multiple facts of the same fact_type are expected. Do not stop after finding one. Extract ALL valid instances present in the document. For example, if there are two SSNs (taxpayer and spouse), extract BOTH as separate facts. If the document contains multiple tax years, extract AGI for EACH year.

DOCUMENT STRUCTURE:
1. HEADER (top right corner):
   - Your social security number (PRIMARY TAXPAYER SSN) - EXTRACT THIS
   - Spouse's social security number (if MFJ) - EXTRACT THIS
   - Tax year
   - Filing status (single, married filing jointly, etc.)

2. TAXPAYER SECTION (below header):
   - Your first name and middle initial, Last name (PRIMARY TAXPAYER)
   - If joint return, spouse's first name and middle initial, Last name
   - Home address (EXTRACT THIS)

3. INCOME SECTION:
   - Line 11: Adjusted Gross Income (AGI) - THIS IS THE ONLY INCOME TO EXTRACT

CRITICAL: ALWAYS EXTRACT SSNs
- SSNs appear in the top-right header area
- Primary taxpayer SSN: labeled "Your social security number"
- Spouse SSN (if MFJ): labeled "Spouse's social security number"
- SSNs may be partially masked (e.g., XXX-XX-1234) - STILL EXTRACT THEM
- Create a SEPARATE ssn fact for EACH taxpayer

INCOME EXTRACTION - ONLY AGI (Line 11):
- Extract ONLY the Adjusted Gross Income from Line 11
- Line 11 is labeled "This is your adjusted gross income"
- Do NOT extract wages, Schedule C income, or other line items separately
- AGI is the summary figure that includes all income sources
- For multi-year documents, extract AGI for EACH tax year as separate income facts

EXTRACTION RULES:
1. Extract SSN for primary taxpayer (REQUIRED if visible)
2. Extract SSN for spouse if married filing jointly (REQUIRED if visible)
3. Extract taxpayer address from the header section
4. For married filing jointly, BOTH names share the address with proximity_score: 3
5. Extract Adjusted Gross Income (AGI) from Line 11 with source_type: "tax_return_1040"

For each fact provide:
- fact_type and value
- evidence with document_id, source_filename, page_number, quote, evidence_source_context
- names_in_proximity: ALL taxpayer names with proximity_score: 3

evidence_source_context values for tax returns:
- tax_return_1040_taxpayer_ssn: SSN from header section (use for ALL ssn facts)
- tax_return_1040_taxpayer_address_block: Taxpayer address section
- other: For AGI and other locations

proximity_score for tax returns:
- ALL taxpayers get proximity_score: 3 (they own all facts on their tax return)
- For married filing jointly, both spouses get proximity_score: 3

value object format: Always include address, string_value, and income. Fill only the relevant one based on fact_type; use empty/defaults for others.
Data formats: Names "First Last", ZIP 5 or 9 digits, SSN XXX-XX-XXXX, dates YYYY-MM-DD, state 2-letter, currency USD.`,

  userPromptTemplate: `Extract facts from this IRS Form 1040 tax return.

DOCUMENT METADATA (use these exact values in all evidence):
- document_id: {{document_id}}
- source_filename: {{source_filename}}

REQUIRED EXTRACTIONS:
1. SSN for primary taxpayer (top-right, "Your social security number")
2. SSN for spouse if MFJ (top-right, "Spouse's social security number")
3. Taxpayer address from the header section
4. Adjusted Gross Income (AGI) from Line 11 ONLY - do NOT extract other income line items

IMPORTANT TAX RETURN RULES:
- Create a SEPARATE ssn fact for EACH taxpayer (do not combine)
- SSN facts MUST use evidence_source_context: "tax_return_1040_taxpayer_ssn"
- Each SSN fact should have its respective taxpayer name in names_in_proximity with proximity_score: 3
- ALL taxpayers (including spouse if MFJ) get proximity_score: 3 on shared facts (address, AGI)
- Income source_type should be "tax_return_1040"
- For multi-year documents, create separate income facts for each year's AGI

DOCUMENT TEXT BY PAGE:
{{page_text}}

Return a facts array. Each fact must have fact_type, value, evidence (at least one), and names_in_proximity.`,
};
