/**
 * Title Report Template
 *
 * Document semantics:
 * - Contains property title history and ownership chain
 * - Contains property address (NOT borrower's current residence)
 * - Contains lender/title company information (NOT borrower's employer)
 * - Does NOT contain borrower identification data relevant for loan verification
 *
 * This document type should return ZERO facts as it does not contain
 * borrower-relevant data for the extraction pipeline.
 */

import type { ExtractionTemplate } from './types';

export const TITLE_REPORT_TEMPLATE: ExtractionTemplate = {
  documentType: 'title_report',
  description: 'Title Report - no facts to extract (property title history only)',

  systemPrompt: `You are a document extraction specialist. This is a Title Report document.

IMPORTANT: Title Reports do NOT contain data relevant for borrower fact extraction.

Title Reports contain:
- Property title history and ownership chain
- Property address (this is the SUBJECT PROPERTY, not borrower's residence)
- Title company and lender information (these are NOT borrower employers)
- Legal descriptions, liens, encumbrances

EXTRACTION RULES:
1. DO NOT extract ANY facts from Title Reports
2. Return an EMPTY facts array: []
3. The property address is NOT the borrower's address - do not extract it
4. The title company/lender names are NOT employer names - do not extract them
5. Any names in the document are property owners in title chain, not necessarily the loan borrowers

Your response must have an empty facts array.`,

  userPromptTemplate: `This is a Title Report document.

DOCUMENT METADATA:
- document_id: {{document_id}}
- source_filename: {{source_filename}}

CRITICAL: Title Reports do not contain borrower-relevant facts for extraction.
- Do NOT extract addresses (they are property addresses, not borrower residences)
- Do NOT extract company names (they are title companies/lenders, not borrower employers)
- Return an EMPTY facts array

DOCUMENT TEXT BY PAGE:
{{page_text}}

Return an empty facts array: {"facts": [], "warnings": []}`,
};
