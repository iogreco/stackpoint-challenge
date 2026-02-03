/**
 * Shared LLM Extraction Logic
 *
 * Provides common LLM extraction functionality used by document extractors.
 * This is refactored from the worker's llm.ts to be shared across extractors.
 */

import OpenAI from 'openai';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger, config } from '../index';
import type { DocumentType, DocumentInfo, Evidence, Fact, FactIncomeValue, NameInProximity } from '../types';
import type { ExtractionTemplate } from '../templates/types';

/**
 * Page text with page number for document extraction
 */
export interface PageText {
  pageNumber: number;
  text: string;
}

/**
 * Raw LLM extraction result
 */
export interface LlmExtractionResult {
  facts: LlmFact[];
  warnings: string[];
}

/**
 * Raw fact shape from LLM
 */
interface LlmFact {
  fact_type: string;
  value: LlmFactValue;
  evidence: Evidence[];
  names_in_proximity: NameInProximity[];
}

/**
 * Raw value shape from LLM (address + string_value + income all required)
 */
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

/**
 * JSON Schema for OpenAI Structured Outputs (facts-based extraction)
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

/**
 * Maximum characters to send to LLM for extraction.
 * gpt-4o-mini has 128k context but performs better with focused input.
 * Set to 35k to accommodate multi-year 1040s (critical pages ~18k + Schedule C ~13k).
 */
const MAX_EXTRACTION_CHARS = 35000;

/**
 * Format page text for extraction
 */
export function formatPageText(pages: PageText[]): string {
  return pages.map((p) => `--- Page ${p.pageNumber} ---\n${p.text}`).join('\n\n');
}

/**
 * Check if a page is a Form 1040 header page (first page of a tax return)
 */
function is1040HeaderPage(page: PageText): boolean {
  const text = page.text;
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
export function prioritizePages(pages: PageText[], documentType: DocumentType): PageText[] {
  if (documentType === 'tax_return_1040') {
    const headerPageNumbers = new Set<number>();
    const followingPageNumbers = new Set<number>();
    const scheduleCPageNumbers = new Set<number>();

    for (const page of pages) {
      if (is1040HeaderPage(page)) {
        headerPageNumbers.add(page.pageNumber);
        followingPageNumbers.add(page.pageNumber + 1);
      }

      const textLower = page.text.toLowerCase();
      if (textLower.includes('schedule c') || textLower.includes('profit or loss from business')) {
        scheduleCPageNumbers.add(page.pageNumber);
      }
    }

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

    return [...headerPages, ...followingPages, ...scheduleCPages, ...otherPages];
  }

  return pages;
}

/**
 * Format page text for extraction with smart truncation for long documents
 */
export function formatPageTextWithLimit(pages: PageText[], documentType: DocumentType): string {
  const prioritized = prioritizePages(pages, documentType);
  let result = '';
  let includedPages = 0;

  const minPages = documentType === 'tax_return_1040' ? 4 : 2;

  for (const page of prioritized) {
    const pageText = `--- Page ${page.pageNumber} ---\n${page.text}\n\n`;

    if (result.length + pageText.length <= MAX_EXTRACTION_CHARS) {
      result += pageText;
      includedPages++;
    } else if (includedPages < minPages) {
      const remaining = MAX_EXTRACTION_CHARS - result.length;
      if (remaining > 500) {
        result += `--- Page ${page.pageNumber} ---\n${page.text.slice(0, remaining - 100)}\n[...truncated]\n\n`;
        includedPages++;
      }
      break;
    } else {
      result += `\n[Document truncated - ${pages.length - includedPages} additional pages not shown]\n`;
      break;
    }
  }

  return result;
}

/**
 * Debug: Write LLM prompts to temp folder for inspection
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

    fs.writeFileSync(
      path.join(debugDir, `${baseFilename}_extraction_text.txt`),
      `Document ID: ${documentInfo.document_id}\n` +
      `Source: ${documentInfo.source_filename}\n` +
      `Document Type: ${documentType}\n` +
      `Text Length: ${extractionText.length} chars\n` +
      `${'='.repeat(80)}\n\n` +
      extractionText
    );

    fs.writeFileSync(
      path.join(debugDir, `${baseFilename}_system_prompt.txt`),
      systemPrompt
    );

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
 * Normalize fact value based on fact type
 */
function normalizeFactValue(factType: string, raw: LlmFactValue): Fact['value'] {
  if (factType === 'address') return raw.address;
  if (factType === 'income') return raw.income as FactIncomeValue;
  return raw.string_value;
}

/**
 * Convert LLM facts to normalized Fact array
 */
export function normalizeLlmFacts(llmFacts: LlmFact[]): Fact[] {
  return llmFacts.map((f) => ({
    fact_type: f.fact_type as Fact['fact_type'],
    value: normalizeFactValue(f.fact_type, f.value),
    evidence: f.evidence ?? [],
    names_in_proximity: f.names_in_proximity ?? [],
  }));
}

/**
 * LLM extraction options
 */
export interface LlmExtractionOptions {
  /** OpenAI API key (uses env var if not provided) */
  apiKey?: string;
  /** LLM model to use */
  model?: string;
  /** Request timeout in milliseconds */
  timeoutMs?: number;
}

/**
 * LLM extraction response with metadata
 */
export interface LlmExtractionResponse {
  /** Extracted facts */
  facts: Fact[];
  /** Warnings from extraction */
  warnings: string[];
  /** LLM model used */
  model: string;
  /** Request ID from OpenAI */
  requestId: string;
  /** Duration in milliseconds */
  durationMs: number;
}

/**
 * Extract facts using LLM with a document template.
 *
 * @param pages - Document pages with text
 * @param docInfo - Document metadata
 * @param template - Extraction template for the document type
 * @param options - LLM options
 * @returns Extraction response with facts and metadata
 */
export async function extractWithLlmTemplate(
  pages: PageText[],
  docInfo: DocumentInfo,
  template: ExtractionTemplate,
  options: LlmExtractionOptions = {}
): Promise<LlmExtractionResponse> {
  const extractionModel = options.model || process.env.LLM_MODEL_TEXT || config.llmModelText;
  const timeoutMs = options.timeoutMs || config.llmRequestTimeoutMs;

  const openai = new OpenAI({
    apiKey: options.apiKey || process.env.OPENAI_API_KEY || config.openaiApiKey,
    timeout: timeoutMs,
    maxRetries: 0, // Disable SDK retries - let BullMQ handle retries at job level
  });

  // Format text with smart truncation
  const pageText = formatPageTextWithLimit(pages, template.documentType);

  // Build user prompt from template
  const userPrompt = template.userPromptTemplate
    .replace('{{document_id}}', docInfo.document_id)
    .replace('{{source_filename}}', docInfo.source_filename)
    .replace('{{page_text}}', pageText);

  // Debug: write prompts to disk for inspection
  debugWritePrompts(docInfo, template.documentType, pageText, template.systemPrompt, userPrompt);

  logger.info('Extracting facts with LLM template', {
    model: extractionModel,
    document_id: docInfo.document_id,
    document_type: template.documentType,
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

    const durationMs = Date.now() - startTime;
    const requestId = response.id || `req_${Date.now()}`;
    const content = response.choices[0]?.message?.content;

    if (!content) {
      throw new Error('Empty response from OpenAI');
    }

    logger.info('LLM extraction complete', {
      model: extractionModel,
      request_id: requestId,
      duration_ms: durationMs,
      tokens_used: response.usage?.total_tokens,
    });

    const result = JSON.parse(content) as LlmExtractionResult;
    const facts = normalizeLlmFacts(result.facts || []);
    const warnings = result.warnings || [];

    logger.debug('LLM fact response', {
      document_id: docInfo.document_id,
      fact_count: facts.length,
    });

    return {
      facts,
      warnings,
      model: extractionModel,
      requestId,
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;

    logger.error('LLM extraction failed', error, {
      model: extractionModel,
      document_id: docInfo.document_id,
      duration_ms: durationMs,
    });

    throw error;
  }
}
