/**
 * LLM Vision Integration
 *
 * Calls OpenAI vision API for PDF fallback extraction.
 */

import fs from 'fs';
import OpenAI from 'openai';
import {
  logger,
  config,
  llmRequestsCounter,
  llmRequestDurationHistogram,
  type ExtractionResult,
  type DocumentInfo,
} from '@stackpoint/shared';

const PROMPT_VERSION = '1.0.0';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || config.openaiApiKey,
  timeout: config.llmRequestTimeoutMs,
});

const SYSTEM_PROMPT = `You are a document extraction specialist using vision capabilities. Extract structured data from loan document images.

For each document, extract:
1. Borrower information (name, addresses, income, identifiers like SSN)
2. Application/loan information (loan number, property address)

CRITICAL REQUIREMENTS:
- Every extracted value MUST include evidence (document_id, source_filename, page_number, and a short quote from the source)
- Use the exact document_id and source_filename provided in the input
- page_number should be 1-indexed (first page is 1)
- Quotes should be short (under 300 chars) and directly support the extracted value
- If a field cannot be found, include it in missing_fields
- Names should be in "First Last" format
- ZIP codes should be 5 digits or 5+4 format
- SSN should be in XXX-XX-XXXX format if found
- Income amounts should be numbers

OUTPUT FORMAT:
Return a JSON object with:
- applications[]: loan/application data found
- borrowers[]: individual borrower data found
- missing_fields[]: top-level fields not found

For borrowers, use borrower_ref like "borrower_1", "borrower_2" etc.
For applications, use application_ref like "application_1".`;

const USER_PROMPT_TEMPLATE = `Extract data from this PDF document.

Document metadata:
- document_id: {{document_id}}
- source_filename: {{source_filename}}

Previous extraction found these items but may be incomplete:
{{previous_result}}

Please extract any missing data from the document images. Focus especially on:
{{missing_fields}}

Return a JSON object with the complete extraction results, merging any data from the previous extraction with new data found in the images.`;

export interface LlmExtractionResult {
  applications: any[];
  borrowers: any[];
  missing_fields: string[];
  warnings?: string[];
}

/**
 * Call OpenAI vision API to extract data from PDF
 */
export async function extractWithVision(
  pdfPath: string,
  documentInfo: DocumentInfo,
  correlationId: string,
  previousResult?: { borrowers: any[]; applications: any[]; missing_fields: string[] }
): Promise<{ result: LlmExtractionResult; requestId: string; model: string }> {
  const model = process.env.LLM_MODEL_PDF || config.llmModelPdf;

  // Read PDF and convert to base64
  const pdfBuffer = fs.readFileSync(pdfPath);
  const base64Pdf = pdfBuffer.toString('base64');

  const previousResultStr = previousResult
    ? JSON.stringify(previousResult, null, 2)
    : 'None';

  const missingFieldsStr = previousResult?.missing_fields?.join(', ') || 'All fields';

  const userPrompt = USER_PROMPT_TEMPLATE
    .replace('{{document_id}}', documentInfo.document_id)
    .replace('{{source_filename}}', documentInfo.source_filename)
    .replace('{{previous_result}}', previousResultStr)
    .replace('{{missing_fields}}', missingFieldsStr);

  logger.info('Calling OpenAI vision for extraction', {
    model,
    document_id: documentInfo.document_id,
    pdf_size_bytes: pdfBuffer.length,
  });

  const startTime = Date.now();

  try {
    const response = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: userPrompt },
            {
              type: 'image_url',
              image_url: {
                url: `data:application/pdf;base64,${base64Pdf}`,
                detail: 'high',
              },
            },
          ],
        },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 4096,
      temperature: 0,
    });

    const duration = (Date.now() - startTime) / 1000;
    llmRequestDurationHistogram.observe({ model }, duration);
    llmRequestsCounter.inc({ model, status: 'success' });

    const requestId = response.id || `req_${Date.now()}`;
    const content = response.choices[0]?.message?.content;

    if (!content) {
      throw new Error('Empty response from OpenAI vision');
    }

    logger.info('OpenAI vision extraction complete', {
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

    logger.error('OpenAI vision extraction failed', error, {
      model,
      document_id: documentInfo.document_id,
    });

    throw error;
  }
}

/**
 * Merge text extraction result with vision result
 */
export function mergeExtractionResults(
  textResult: { borrowers: any[]; applications: any[]; missing_fields: string[] } | undefined,
  visionResult: LlmExtractionResult
): LlmExtractionResult {
  if (!textResult) {
    return visionResult;
  }

  // Merge borrowers - prefer vision result for completeness
  const borrowers = visionResult.borrowers.length > 0
    ? visionResult.borrowers
    : textResult.borrowers;

  // Merge applications - prefer vision result
  const applications = visionResult.applications.length > 0
    ? visionResult.applications
    : textResult.applications;

  // Missing fields should be from vision result (should be fewer)
  const missing_fields = visionResult.missing_fields;

  return {
    borrowers,
    applications,
    missing_fields,
    warnings: visionResult.warnings,
  };
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
    extraction_mode: 'pdf_fallback',
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
