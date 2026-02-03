/**
 * Extractor Registry
 *
 * Registry pattern for document extractors.
 * Allows registering extractors for each document type and retrieving them.
 */

import type { DocumentType } from '../types';
import type { DocumentExtractor } from './types';
import { logger } from '../logger';

/**
 * Map of document types to their extractors
 */
const extractorRegistry = new Map<DocumentType, DocumentExtractor>();

/**
 * Register an extractor for a document type.
 * Overwrites any existing extractor for that type.
 *
 * @param extractor - The extractor to register
 */
export function registerExtractor(extractor: DocumentExtractor): void {
  extractorRegistry.set(extractor.documentType, extractor);

  logger.debug('Registered extractor', {
    document_type: extractor.documentType,
    strategy: extractor.strategy,
    description: extractor.description,
  });
}

/**
 * Get the extractor for a document type.
 *
 * @param documentType - The document type
 * @returns The extractor for that type, or undefined if not registered
 */
export function getExtractor(documentType: DocumentType): DocumentExtractor | undefined {
  return extractorRegistry.get(documentType);
}

/**
 * Get the extractor for a document type, throwing if not found.
 *
 * @param documentType - The document type
 * @returns The extractor for that type
 * @throws Error if no extractor is registered for that type
 */
export function getExtractorOrThrow(documentType: DocumentType): DocumentExtractor {
  const extractor = extractorRegistry.get(documentType);
  if (!extractor) {
    throw new Error(`No extractor registered for document type: ${documentType}`);
  }
  return extractor;
}

/**
 * Check if an extractor is registered for a document type.
 *
 * @param documentType - The document type
 * @returns True if an extractor is registered
 */
export function hasExtractor(documentType: DocumentType): boolean {
  return extractorRegistry.has(documentType);
}

/**
 * Get all registered document types.
 *
 * @returns Array of document types with registered extractors
 */
export function getRegisteredTypes(): DocumentType[] {
  return Array.from(extractorRegistry.keys());
}

/**
 * Get all registered extractors.
 *
 * @returns Array of all registered extractors
 */
export function getAllExtractors(): DocumentExtractor[] {
  return Array.from(extractorRegistry.values());
}

/**
 * Clear all registered extractors.
 * Useful for testing.
 */
export function clearRegistry(): void {
  extractorRegistry.clear();
}

/**
 * Get registry statistics
 */
export function getRegistryStats(): {
  totalExtractors: number;
  byStrategy: Record<string, number>;
  documentTypes: DocumentType[];
} {
  const extractors = getAllExtractors();
  const byStrategy: Record<string, number> = {};

  for (const extractor of extractors) {
    byStrategy[extractor.strategy] = (byStrategy[extractor.strategy] || 0) + 1;
  }

  return {
    totalExtractors: extractors.length,
    byStrategy,
    documentTypes: getRegisteredTypes(),
  };
}
