/**
 * Document Classification and Extraction Template Types
 *
 * Defines the interface for document-specific extraction templates
 * that encode document semantics for improved proximity scoring.
 */

import type { DocumentType } from '../types';

/**
 * Extraction template for a specific document type.
 * Each template encodes document-specific rules for fact extraction.
 */
export interface ExtractionTemplate {
  /** The document type this template handles */
  documentType: DocumentType;

  /** System prompt with document-specific extraction rules */
  systemPrompt: string;

  /**
   * User prompt template with placeholders:
   * - {{document_id}}: The document's unique identifier
   * - {{source_filename}}: The original filename
   * - {{page_text}}: The extracted text content (for text extraction)
   */
  userPromptTemplate: string;

  /** Human-readable description of what this template extracts */
  description: string;
}

/**
 * Classification result from the fast classification model
 */
export interface ClassificationResult {
  /** The identified document type */
  document_type: DocumentType;

  /** Confidence score from 0 to 1 */
  confidence: number;

  /** Optional reasoning for the classification */
  reasoning?: string;
}
