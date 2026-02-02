/**
 * Document Classification and Extraction Templates
 *
 * Two-step extraction approach:
 * 1. Classification: Fast model identifies document type
 * 2. Extraction: Document-specific template with precise instructions
 */

import type { DocumentType } from '../types';
import type { ExtractionTemplate, ClassificationResult } from './types';

// Export types
export type { ExtractionTemplate, ClassificationResult } from './types';

// Export classification utilities
export {
  CLASSIFICATION_SYSTEM_PROMPT,
  CLASSIFICATION_USER_PROMPT_TEMPLATE,
  CLASSIFICATION_SCHEMA,
  DOCUMENT_TYPE_NAMES,
} from './classification';

// Import templates
import { W2_TEMPLATE } from './w2.template';
import { PAYSTUB_TEMPLATE } from './paystub.template';
import { BANK_STATEMENT_TEMPLATE } from './bank-statement.template';
import { CLOSING_DISCLOSURE_TEMPLATE } from './closing-disclosure.template';
import { TAX_RETURN_1040_TEMPLATE } from './tax-return-1040.template';
import { EVOE_TEMPLATE } from './evoe.template';
import { TRANSMITTAL_SUMMARY_TEMPLATE } from './transmittal-summary.template';
import { UNKNOWN_TEMPLATE } from './unknown.template';

// Export individual templates
export {
  W2_TEMPLATE,
  PAYSTUB_TEMPLATE,
  BANK_STATEMENT_TEMPLATE,
  CLOSING_DISCLOSURE_TEMPLATE,
  TAX_RETURN_1040_TEMPLATE,
  EVOE_TEMPLATE,
  TRANSMITTAL_SUMMARY_TEMPLATE,
  UNKNOWN_TEMPLATE,
};

/**
 * Map of document types to their extraction templates
 */
const TEMPLATES: Record<DocumentType, ExtractionTemplate> = {
  w2: W2_TEMPLATE,
  paystub: PAYSTUB_TEMPLATE,
  bank_statement: BANK_STATEMENT_TEMPLATE,
  closing_disclosure: CLOSING_DISCLOSURE_TEMPLATE,
  tax_return_1040: TAX_RETURN_1040_TEMPLATE,
  evoe: EVOE_TEMPLATE,
  transmittal_summary: TRANSMITTAL_SUMMARY_TEMPLATE,
  unknown: UNKNOWN_TEMPLATE,
};

/**
 * Get the extraction template for a specific document type.
 * Returns the unknown template if type is not recognized.
 *
 * @param documentType - The classified document type
 * @returns The appropriate extraction template
 */
export function getTemplateForDocumentType(documentType: DocumentType): ExtractionTemplate {
  return TEMPLATES[documentType] || UNKNOWN_TEMPLATE;
}

/**
 * Get all available document types
 */
export function getAvailableDocumentTypes(): DocumentType[] {
  return Object.keys(TEMPLATES) as DocumentType[];
}
