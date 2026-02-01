/**
 * LLM Integration
 *
 * Calls OpenAI for structured data extraction from document text.
 */

import OpenAI from 'openai';
import {
  logger,
  config,
  llmRequestsCounter,
  llmRequestDurationHistogram,
  type ExtractionResult,
  type DocumentInfo,
} from '@stackpoint/shared';
import type { PageText } from './pdf';

const PROMPT_VERSION = '1.0.0';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || config.openaiApiKey,
  timeout: config.llmRequestTimeoutMs,
});

const SYSTEM_PROMPT = `You are a document extraction specialist. Extract structured data from loan documents.

For each document, extract:
1. Borrower information (name, addresses, income, identifiers like SSN)
2. Application/loan information (loan number, property address)

CRITICAL REQUIREMENTS:
- Every extracted value MUST include evidence (document_id, source_filename, page_number, and a short quote from the source text)
- Use the exact document_id and source_filename provided in the input
- page_number should be 1-indexed (first page is 1)
- Quotes should be short (under 300 chars) and directly support the extracted value
- If a field cannot be found, include it in missing_fields
- Names should be in "First Last" format
- ZIP codes should be 5 digits or 5+4 format (e.g., "12345" or "12345-6789")
- SSN should be in XXX-XX-XXXX format if found
- Income amounts should be numbers (not strings)

OUTPUT FORMAT:
Return a JSON object matching the ExtractionResult schema with:
- applications[]: loan/application data found
- borrowers[]: individual borrower data found
- missing_fields[]: top-level fields not found

For borrowers, use borrower_ref like "borrower_1", "borrower_2" etc.
For applications, use application_ref like "application_1".
Link borrowers to applications via the parties[] array.`;

const USER_PROMPT_TEMPLATE = `Extract data from this document.

Document metadata:
- document_id: {{document_id}}
- source_filename: {{source_filename}}

Document text by page:
{{page_text}}

Return a JSON object with the extraction results. Include all borrowers and applications found.
For each extracted value, include evidence with document_id, source_filename, page_number, and a supporting quote.`;

export interface LlmExtractionResult {
  applications: any[];
  borrowers: any[];
  missing_fields: string[];
  warnings?: string[];
}

/**
 * Call OpenAI to extract data from document text
 */
export async function extractWithLlm(
  pages: PageText[],
  documentInfo: DocumentInfo,
  correlationId: string
): Promise<{ result: LlmExtractionResult; requestId: string; model: string }> {
  const model = process.env.LLM_MODEL_TEXT || config.llmModelText;

  // Format page text
  const pageText = pages
    .map((p) => `--- Page ${p.pageNumber} ---\n${p.text}`)
    .join('\n\n');

  const userPrompt = USER_PROMPT_TEMPLATE
    .replace('{{document_id}}', documentInfo.document_id)
    .replace('{{source_filename}}', documentInfo.source_filename)
    .replace('{{page_text}}', pageText);

  logger.info('Calling OpenAI for extraction', {
    model,
    document_id: documentInfo.document_id,
    text_length: pageText.length,
    page_count: pages.length,
  });

  const startTime = Date.now();

  try {
    const response = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
    });

    const duration = (Date.now() - startTime) / 1000;
    llmRequestDurationHistogram.observe({ model }, duration);
    llmRequestsCounter.inc({ model, status: 'success' });

    const requestId = response.id || `req_${Date.now()}`;
    const content = response.choices[0]?.message?.content;

    if (!content) {
      throw new Error('Empty response from OpenAI');
    }

    logger.info('OpenAI extraction complete', {
      model,
      request_id: requestId,
      duration_seconds: duration,
      tokens_used: response.usage?.total_tokens,
    });

    const result = JSON.parse(content) as LlmExtractionResult;

    // Ensure required arrays exist
    result.applications = result.applications || [];
    result.borrowers = result.borrowers || [];
    result.missing_fields = result.missing_fields || [];

    return { result, requestId, model };
  } catch (error) {
    const duration = (Date.now() - startTime) / 1000;
    llmRequestDurationHistogram.observe({ model }, duration);
    llmRequestsCounter.inc({ model, status: 'error' });

    logger.error('OpenAI extraction failed', error, {
      model,
      document_id: documentInfo.document_id,
    });

    throw error;
  }
}

/**
 * Build complete ExtractionResult from LLM output
 */
export function buildExtractionResult(
  llmResult: LlmExtractionResult,
  documentInfo: DocumentInfo,
  correlationId: string,
  model: string,
  requestId: string
): ExtractionResult {
  return {
    schema_version: '1.1.0',
    correlation_id: correlationId,
    document: documentInfo,
    extraction_mode: 'text',
    applications: llmResult.applications,
    borrowers: llmResult.borrowers,
    missing_fields: llmResult.missing_fields as any,
    warnings: llmResult.warnings,
    extraction_metadata: {
      provider: 'openai',
      model,
      request_id: requestId,
      prompt_version: PROMPT_VERSION,
    },
    created_at: new Date().toISOString(),
  };
}

/**
 * Check if extraction needs PDF fallback
 */
export function needsPdfFallback(result: LlmExtractionResult): boolean {
  // Need fallback if we found no borrowers or all borrowers are missing critical fields
  if (result.borrowers.length === 0) {
    return true;
  }

  // Check if any borrower is missing core fields
  const criticalMissing = result.missing_fields.some(
    (f) =>
      f === 'borrower.full_name' ||
      f === 'borrower.zip'
  );

  return criticalMissing;
}
