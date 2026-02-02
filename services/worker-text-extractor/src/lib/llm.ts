/**
 * LLM Integration (Two-Step Extraction)
 *
 * Two-step approach:
 * 1. Classification: Fast model identifies document type (gpt-5-nano)
 * 2. Extraction: Document-specific template with precise instructions (gpt-5-mini)
 *
 * This solves:
 * - Proximity scoring failures (templates encode document semantics)
 * - Lost document structure (templates know which sections matter)
 * - Generic prompts ignoring document-specific rules
 */

import OpenAI from 'openai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  logger,
  config,
  llmRequestsCounter,
  llmRequestDurationHistogram,
  type DocumentInfo,
  type DocumentType,
  type Evidence,
  type Fact,
  type FactExtractionResult,
  type FactIncomeValue,
  type NameInProximity,
  getTemplateForDocumentType,
  CLASSIFICATION_SYSTEM_PROMPT,
  CLASSIFICATION_USER_PROMPT_TEMPLATE,
  CLASSIFICATION_SCHEMA,
  DOCUMENT_TYPE_NAMES,
  type ClassificationResult,
} from '@stackpoint/shared';
import type { PageText } from './pdf';

const PROMPT_VERSION = '4.0.0-two-step';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || config.openaiApiKey,
  timeout: config.llmRequestTimeoutMs,
});

/**
 * JSON Schema for OpenAI Structured Outputs (facts-based extraction).
 */
const FACT_EXTRACTION_SCHEMA = {
  name: 'fact_document_extraction',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['facts', 'warnings'],
    properties: {
      facts: {
        type: 'array',
        description: 'List of extracted facts (address, SSN, income, loan number, employer name) with names in proximity and proximity scores',
        items: { $ref: '#/$defs/fact' },
      },
      warnings: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    $defs: {
      evidence: {
        type: 'object',
        additionalProperties: false,
        required: ['document_id', 'source_filename', 'page_number', 'quote', 'evidence_source_context'],
        properties: {
          document_id: { type: 'string' },
          source_filename: { type: 'string' },
          page_number: { type: 'integer' },
          quote: { type: 'string', maxLength: 300 },
          evidence_source_context: {
            type: 'string',
            enum: [
              'tax_return_1040_taxpayer_address_block',
              'w2_employee_address_block',
              'closing_disclosure_borrower_section',
              'bank_statement_account_holder_address_block',
              'paystub_employee_info_block',
              'paystub_header_employer_block',
              'w2_employer_address_block',
              'tax_return_1040_taxpayer_ssn',
              'w2_employee_ssn',
              'w2_wages_boxes_annual',
              'tax_return_1040_schedule_c_net_profit',
              'paystub_ytd_rate_of_pay',
              'evoe_verification',
              'letter_of_explanation',
              'other',
            ],
          },
        },
      },
      name_in_proximity: {
        type: 'object',
        additionalProperties: false,
        required: ['full_name', 'evidence', 'proximity_score'],
        properties: {
          full_name: { type: 'string' },
          evidence: {
            type: 'array',
            minItems: 1,
            items: { $ref: '#/$defs/evidence' },
          },
          proximity_score: {
            type: 'integer',
            minimum: 0,
            maximum: 3,
            description: '3=same line, 2=within 1 line, 1=within 2-3 lines, 0=farther',
          },
        },
      },
      address_value: {
        type: 'object',
        additionalProperties: false,
        required: ['street1', 'street2', 'city', 'state', 'zip'],
        properties: {
          street1: { type: 'string' },
          street2: { type: 'string' },
          city: { type: 'string' },
          state: { type: 'string' },
          zip: { type: 'string' },
        },
      },
      income_period: {
        type: 'object',
        additionalProperties: false,
        required: ['year', 'start_date', 'end_date'],
        properties: {
          year: { type: 'integer' },
          start_date: { type: 'string' },
          end_date: { type: 'string' },
        },
      },
      fact_income_value: {
        type: 'object',
        additionalProperties: false,
        required: ['amount', 'currency', 'frequency', 'period', 'employer', 'source_type'],
        properties: {
          amount: { type: 'number' },
          currency: { type: 'string' },
          frequency: { type: 'string', enum: ['annual', 'monthly', 'biweekly', 'weekly', 'daily', 'unknown'] },
          period: { $ref: '#/$defs/income_period' },
          employer: { type: 'string' },
          source_type: {
            type: 'string',
            enum: ['w2', 'paystub', 'evoe', 'tax_return_1040', 'schedule_c', 'bank_statement', 'other'],
          },
        },
      },
      fact_value: {
        type: 'object',
        additionalProperties: false,
        required: ['address', 'string_value', 'income'],
        description: 'Exactly one branch applies by fact_type: address->address, ssn/loan_number/employer_name->string_value, income->income. Fill others with empty/default.',
        properties: {
          address: { $ref: '#/$defs/address_value' },
          string_value: { type: 'string' },
          income: { $ref: '#/$defs/fact_income_value' },
        },
      },
      fact: {
        type: 'object',
        additionalProperties: false,
        required: ['fact_type', 'value', 'evidence', 'names_in_proximity'],
        properties: {
          fact_type: {
            type: 'string',
            enum: ['address', 'ssn', 'income', 'loan_number', 'employer_name'],
          },
          value: { $ref: '#/$defs/fact_value' },
          evidence: {
            type: 'array',
            minItems: 1,
            items: { $ref: '#/$defs/evidence' },
          },
          names_in_proximity: {
            type: 'array',
            description: 'All full names observed near this fact with proximity_score (0-3)',
            items: { $ref: '#/$defs/name_in_proximity' },
          },
        },
      },
    },
  },
} as const;

export interface LlmFactExtractionResult {
  facts: any[];
  warnings?: string[];
}

/**
 * Classification result with metadata for tracking
 */
export interface ClassificationWithMetadata extends ClassificationResult {
  model: string;
  requestId: string;
}

/**
 * Format page text for extraction
 */
function formatPageText(pages: PageText[]): string {
  return pages.map((p) => `--- Page ${p.pageNumber} ---\n${p.text}`).join('\n\n');
}

/**
 * Debug: Write LLM prompts to temp folder for inspection.
 * Enable by setting DEBUG_LLM_PROMPTS=1 and optionally DEBUG_LLM_PROMPTS_DIR=/path/to/dir
 */
function debugWritePrompts(
  documentInfo: DocumentInfo,
  documentType: DocumentType,
  extractionText: string,
  systemPrompt: string,
  userPrompt: string
): void {
  if (!process.env.DEBUG_LLM_PROMPTS) return;

  const debugDir = process.env.DEBUG_LLM_PROMPTS_DIR || '/tmp/llm-debug';

  try {
    if (!fs.existsSync(debugDir)) {
      fs.mkdirSync(debugDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const baseFilename = `${timestamp}_${documentInfo.document_id}`;

    // Write the raw extraction text (what gets interpolated into the template)
    fs.writeFileSync(
      path.join(debugDir, `${baseFilename}_extraction_text.txt`),
      `Document ID: ${documentInfo.document_id}\n` +
      `Source: ${documentInfo.source_filename}\n` +
      `Document Type: ${documentType}\n` +
      `Text Length: ${extractionText.length} chars\n` +
      `${'='.repeat(80)}\n\n` +
      extractionText
    );

    // Write the full system prompt
    fs.writeFileSync(
      path.join(debugDir, `${baseFilename}_system_prompt.txt`),
      systemPrompt
    );

    // Write the full user prompt (with interpolated values)
    fs.writeFileSync(
      path.join(debugDir, `${baseFilename}_user_prompt.txt`),
      userPrompt
    );

    logger.info('Debug: wrote LLM prompts to disk', {
      debug_dir: debugDir,
      document_id: documentInfo.document_id,
      files: [`${baseFilename}_extraction_text.txt`, `${baseFilename}_system_prompt.txt`, `${baseFilename}_user_prompt.txt`],
    });
  } catch (err) {
    logger.warn('Debug: failed to write LLM prompts', { error: String(err) });
  }
}

/**
 * Maximum characters to send to LLM for extraction.
 * gpt-4o-mini has 128k context but performs better with focused input.
 * Set to 35k to accommodate multi-year 1040s (critical pages ~18k + Schedule C ~13k).
 */
const MAX_EXTRACTION_CHARS = 35000;

/**
 * Check if a page is a Form 1040 header page (first page of a tax return).
 * These pages contain SSN, address, and filing status - critical for extraction.
 */
function is1040HeaderPage(page: PageText): boolean {
  const text = page.text;
  // Look for "US Individual Income Tax Return" which appears on the first page of each 1040
  // Also check for year + 1040 pattern at the start (e.g., "2024 1040" or "2023 1040")
  const hasIndividualTaxReturn = text.includes('Individual Income Tax Return');
  const hasYearPattern = /\b20\d{2}\s+1040\b/.test(text.slice(0, 500));
  const hasFormHeader = /^Department of the Treasury/m.test(text.slice(0, 200));

  return hasIndividualTaxReturn && (hasYearPattern || hasFormHeader);
}

/**
 * Prioritize pages for extraction based on document type.
 * For tax returns with multiple years: detect ALL 1040 header pages + their following pages
 * For other documents: first pages up to limit
 */
function prioritizePages(pages: PageText[], documentType: DocumentType): PageText[] {
  if (documentType === 'tax_return_1040') {
    // For multi-year 1040 documents: find ALL header pages (first page of each tax year)
    const headerPageNumbers = new Set<number>();
    const followingPageNumbers = new Set<number>();
    const scheduleCPageNumbers = new Set<number>();

    for (const page of pages) {
      if (is1040HeaderPage(page)) {
        headerPageNumbers.add(page.pageNumber);
        // Also include the following page (contains signature, additional info)
        followingPageNumbers.add(page.pageNumber + 1);
      }

      const textLower = page.text.toLowerCase();
      if (textLower.includes('schedule c') || textLower.includes('profit or loss from business')) {
        scheduleCPageNumbers.add(page.pageNumber);
      }
    }

    // Build prioritized list
    const headerPages: PageText[] = [];
    const followingPages: PageText[] = [];
    const scheduleCPages: PageText[] = [];
    const otherPages: PageText[] = [];

    for (const page of pages) {
      if (headerPageNumbers.has(page.pageNumber)) {
        headerPages.push(page);
      } else if (followingPageNumbers.has(page.pageNumber)) {
        followingPages.push(page);
      } else if (scheduleCPageNumbers.has(page.pageNumber)) {
        scheduleCPages.push(page);
      } else {
        otherPages.push(page);
      }
    }

    logger.debug('1040 page prioritization', {
      total_pages: pages.length,
      header_pages: Array.from(headerPageNumbers).sort((a, b) => a - b),
      following_pages: Array.from(followingPageNumbers).sort((a, b) => a - b),
      schedule_c_pages: Array.from(scheduleCPageNumbers).sort((a, b) => a - b),
    });

    // Return: header pages first, then their following pages, then Schedule C, then others
    return [...headerPages, ...followingPages, ...scheduleCPages, ...otherPages];
  }

  // For other document types, just return pages as-is
  return pages;
}

/**
 * Format page text for extraction with smart truncation for long documents.
 */
function formatPageTextWithLimit(pages: PageText[], documentType: DocumentType): string {
  const prioritized = prioritizePages(pages, documentType);
  let result = '';
  let includedPages = 0;

  // For multi-year 1040s, ensure we include at least 4 pages (both years' headers)
  const minPages = documentType === 'tax_return_1040' ? 4 : 2;

  for (const page of prioritized) {
    const pageText = `--- Page ${page.pageNumber} ---\n${page.text}\n\n`;

    if (result.length + pageText.length <= MAX_EXTRACTION_CHARS) {
      result += pageText;
      includedPages++;
    } else if (includedPages < minPages) {
      // Always include minimum required pages, truncating if needed
      const remaining = MAX_EXTRACTION_CHARS - result.length;
      if (remaining > 500) {
        result += `--- Page ${page.pageNumber} ---\n${page.text.slice(0, remaining - 100)}\n[...truncated]\n\n`;
        includedPages++;
      }
      break;
    } else {
      // Add note about truncation
      result += `\n[Document truncated - ${pages.length - includedPages} additional pages not shown]\n`;
      break;
    }
  }

  return result;
}

/**
 * STEP 1: Classify document type using fast model
 */
export async function classifyDocument(
  pageText: string,
  documentInfo: DocumentInfo
): Promise<ClassificationWithMetadata> {
  const classificationModel = process.env.LLM_MODEL_CLASSIFICATION || config.llmModelClassification;
  const confidenceThreshold = config.classificationConfidenceThreshold;

  // Use first ~2000 characters for classification (fast preview)
  const preview = pageText.slice(0, 2000);

  const userPrompt = CLASSIFICATION_USER_PROMPT_TEMPLATE.replace('{{preview}}', preview);

  logger.info('Classifying document type', {
    model: classificationModel,
    document_id: documentInfo.document_id,
    preview_length: preview.length,
  });

  const startTime = Date.now();

  try {
    // Note: gpt-5-nano does not support temperature=0, so we omit it
    const response = await openai.chat.completions.create({
      model: classificationModel,
      messages: [
        { role: 'system', content: CLASSIFICATION_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: CLASSIFICATION_SCHEMA,
      },
    });

    const duration = (Date.now() - startTime) / 1000;
    llmRequestDurationHistogram.observe({ model: classificationModel }, duration);
    llmRequestsCounter.inc({ model: classificationModel, status: 'success' });

    const requestId = response.id || `req_class_${Date.now()}`;
    const content = response.choices[0]?.message?.content;

    if (!content) {
      throw new Error('Empty classification response from OpenAI');
    }

    const classification = JSON.parse(content) as ClassificationResult;

    // Fall back to unknown if confidence is too low
    let documentType: DocumentType = classification.document_type;
    if (classification.confidence < confidenceThreshold) {
      logger.warn('Classification confidence below threshold, using unknown', {
        document_id: documentInfo.document_id,
        classified_type: classification.document_type,
        confidence: classification.confidence,
        threshold: confidenceThreshold,
      });
      documentType = 'unknown';
    }

    logger.info('Document classified', {
      model: classificationModel,
      document_id: documentInfo.document_id,
      document_type: documentType,
      document_type_name: DOCUMENT_TYPE_NAMES[documentType],
      confidence: classification.confidence,
      reasoning: classification.reasoning,
      duration_seconds: duration,
    });

    return {
      document_type: documentType,
      confidence: classification.confidence,
      reasoning: classification.reasoning,
      model: classificationModel,
      requestId,
    };
  } catch (error) {
    const duration = (Date.now() - startTime) / 1000;
    llmRequestDurationHistogram.observe({ model: classificationModel }, duration);
    llmRequestsCounter.inc({ model: classificationModel, status: 'error' });

    logger.error('Document classification failed', error, {
      model: classificationModel,
      document_id: documentInfo.document_id,
    });

    // On classification failure, return unknown with zero confidence
    return {
      document_type: 'unknown',
      confidence: 0,
      reasoning: 'Classification failed, using fallback',
      model: classificationModel,
      requestId: `req_class_error_${Date.now()}`,
    };
  }
}

/**
 * STEP 2: Extract facts using document-specific template
 */
async function extractWithTemplate(
  pageText: string,
  documentInfo: DocumentInfo,
  documentType: DocumentType
): Promise<{ result: LlmFactExtractionResult; requestId: string; model: string }> {
  const extractionModel = process.env.LLM_MODEL_TEXT || config.llmModelText;
  const template = getTemplateForDocumentType(documentType);

  const userPrompt = template.userPromptTemplate
    .replace('{{document_id}}', documentInfo.document_id)
    .replace('{{source_filename}}', documentInfo.source_filename)
    .replace('{{page_text}}', pageText);

  // Debug: write prompts to disk for inspection
  debugWritePrompts(documentInfo, documentType, pageText, template.systemPrompt, userPrompt);

  logger.info('Extracting facts with template', {
    model: extractionModel,
    document_id: documentInfo.document_id,
    document_type: documentType,
    template_description: template.description,
    text_length: pageText.length,
  });

  const startTime = Date.now();

  try {
    const response = await openai.chat.completions.create({
      model: extractionModel,
      messages: [
        { role: 'system', content: template.systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: FACT_EXTRACTION_SCHEMA,
      },
      temperature: 0,
    });

    const duration = (Date.now() - startTime) / 1000;
    llmRequestDurationHistogram.observe({ model: extractionModel }, duration);
    llmRequestsCounter.inc({ model: extractionModel, status: 'success' });

    const requestId = response.id || `req_${Date.now()}`;
    const content = response.choices[0]?.message?.content;

    if (!content) {
      throw new Error('Empty response from OpenAI');
    }

    logger.info('OpenAI fact extraction complete', {
      model: extractionModel,
      request_id: requestId,
      duration_seconds: duration,
      tokens_used: response.usage?.total_tokens,
    });

    const result = JSON.parse(content) as LlmFactExtractionResult;
    result.facts = result.facts || [];
    result.warnings = result.warnings || [];

    logger.debug('LLM fact response', {
      document_id: documentInfo.document_id,
      fact_count: result.facts.length,
    });

    return { result, requestId, model: extractionModel };
  } catch (error) {
    const duration = (Date.now() - startTime) / 1000;
    llmRequestDurationHistogram.observe({ model: extractionModel }, duration);
    llmRequestsCounter.inc({ model: extractionModel, status: 'error' });

    logger.error('OpenAI fact extraction failed', error, {
      model: extractionModel,
      document_id: documentInfo.document_id,
    });

    throw error;
  }
}

/**
 * Two-step extraction: Classify then extract with document-specific template
 */
export async function extractWithLlm(
  pages: PageText[],
  documentInfo: DocumentInfo,
  correlationId: string
): Promise<{
  result: LlmFactExtractionResult;
  requestId: string;
  model: string;
  classification: ClassificationWithMetadata;
}> {
  // Format full page text for classification (needs accurate doc type detection)
  const fullPageText = formatPageText(pages);

  // STEP 1: Classify document type using full text
  const classification = await classifyDocument(fullPageText, documentInfo);

  // STEP 2: Extract with document-specific template
  // Use smart truncation for long documents (prioritizes important pages)
  const extractionText = formatPageTextWithLimit(pages, classification.document_type);

  logger.debug('Extraction text preparation', {
    document_id: documentInfo.document_id,
    document_type: classification.document_type,
    full_text_length: fullPageText.length,
    extraction_text_length: extractionText.length,
    truncated: extractionText.length < fullPageText.length,
  });

  const extraction = await extractWithTemplate(extractionText, documentInfo, classification.document_type);

  return {
    ...extraction,
    classification,
  };
}

/** Raw value shape from LLM (address + string_value + income all required). */
interface LlmFactValue {
  address: { street1: string; street2: string; city: string; state: string; zip: string };
  string_value: string;
  income: {
    amount: number;
    currency: string;
    frequency: string;
    period: { year: number; start_date: string; end_date: string };
    employer: string;
    source_type: string;
  };
}

function normalizeFactValue(factType: string, raw: LlmFactValue): Fact['value'] {
  if (factType === 'address') return raw.address;
  if (factType === 'income') return raw.income as FactIncomeValue;
  return raw.string_value;
}

/**
 * Build FactExtractionResult from LLM output with classification metadata
 */
export function buildFactExtractionResult(
  llmResult: LlmFactExtractionResult,
  documentInfo: DocumentInfo,
  correlationId: string,
  model: string,
  requestId: string,
  classification?: ClassificationWithMetadata
): FactExtractionResult {
  const facts: Fact[] = (llmResult.facts || []).map((f: { fact_type: string; value: LlmFactValue; evidence: Evidence[]; names_in_proximity: NameInProximity[] }) => ({
    fact_type: f.fact_type as Fact['fact_type'],
    value: normalizeFactValue(f.fact_type, f.value),
    evidence: f.evidence ?? [],
    names_in_proximity: f.names_in_proximity ?? [],
  }));

  return {
    schema_version: '2.0',
    correlation_id: correlationId,
    document: documentInfo,
    extraction_mode: 'text',
    facts,
    warnings: llmResult.warnings,
    extraction_metadata: {
      provider: 'openai',
      model,
      request_id: requestId,
      prompt_version: PROMPT_VERSION,
      document_type: classification?.document_type,
      classification_model: classification?.model,
      classification_confidence: classification?.confidence,
    },
    created_at: new Date().toISOString(),
  };
}

/**
 * Check if fact extraction needs PDF fallback (e.g. validation failed or no facts)
 */
export function needsPdfFallbackFacts(result: LlmFactExtractionResult): boolean {
  return result.facts.length === 0;
}
