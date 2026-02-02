/**
 * LLM Vision Integration
 *
 * Uses OpenAI vision API for fact-based extraction (PDF fallback).
 * Same fact schema and prompts as text extractor; merges facts when text result exists.
 */

import fs from 'fs';
import OpenAI from 'openai';
import {
  logger,
  config,
  llmRequestsCounter,
  llmRequestDurationHistogram,
  type DocumentInfo,
  type Evidence,
  type Fact,
  type FactExtractionResult,
  type FactIncomeValue,
  type NameInProximity,
} from '@stackpoint/shared';

const PROMPT_VERSION = '3.0.0-facts';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || config.openaiApiKey,
  timeout: config.llmRequestTimeoutMs,
});

/**
 * JSON Schema for OpenAI Structured Outputs (facts-based, aligned with text extractor).
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
        description: 'List of extracted facts with names_in_proximity and proximity_score',
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
          proximity_score: { type: 'integer', minimum: 0, maximum: 3 },
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
            items: { $ref: '#/$defs/name_in_proximity' },
          },
        },
      },
    },
  },
} as const;

const SYSTEM_PROMPT = `You are a document extraction specialist using vision. Extract FACTS from loan document PDFs. For each fact list ALL full names near it with proximity_score (0-3).

FACT TYPES: address, ssn, income, loan_number, employer_name
value is an object with address, string_value, and income. Fill only the one that matches fact_type (address->address, ssn/loan_number/employer_name->string_value, income->income); use empty/default for the other two.
For each fact: value, evidence (document_id, source_filename, page_number, quote, evidence_source_context), names_in_proximity (full_name, evidence, proximity_score).
proximity_score: 3=same line, 2=within 1 line, 1=within 2-3 lines, 0=farther.
For loan_number: list all applicant names (score 0 if far).
EVIDENCE SOURCE CONTEXT: use address/income context strings or "other".
DATA: Names "First Last", ZIP 5 or 5+4, SSN XXX-XX-XXXX, dates YYYY-MM-DD, state 2-letter, currency USD.`;

const USER_PROMPT_TEMPLATE = `Extract facts from this loan document PDF.

DOCUMENT METADATA (use in all evidence):
- document_id: {{document_id}}
- source_filename: {{source_filename}}

{{previous_result}}

Return a facts array. Each fact: fact_type, value (address + string_value + income; fill only the branch for fact_type), evidence, names_in_proximity (proximity_score 0-3).`;

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

function isRawFactValue(v: unknown): v is LlmFactValue {
  return (
    typeof v === 'object' &&
    v !== null &&
    'address' in v &&
    'string_value' in v &&
    'income' in v
  );
}

export interface LlmFactExtractionResult {
  facts: any[];
  warnings?: string[];
}

/**
 * Call OpenAI vision API for fact extraction
 */
export async function extractWithVision(
  pdfPath: string,
  documentInfo: DocumentInfo,
  correlationId: string,
  previousFacts?: { facts: any[] }
): Promise<{ result: LlmFactExtractionResult; requestId: string; model: string }> {
  const model = process.env.LLM_MODEL_PDF || config.llmModelPdf;

  const pdfBuffer = fs.readFileSync(pdfPath);
  const base64Pdf = pdfBuffer.toString('base64');

  const previousResultStr = previousFacts?.facts?.length
    ? `Previous extraction found ${previousFacts.facts.length} facts. Add or correct facts from the PDF.`
    : 'Extract all facts from the document.';

  const userPrompt = USER_PROMPT_TEMPLATE
    .replace('{{document_id}}', documentInfo.document_id)
    .replace('{{source_filename}}', documentInfo.source_filename)
    .replace('{{previous_result}}', previousResultStr);

  logger.info('Calling OpenAI vision for fact extraction', {
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
            {
              type: 'file',
              file: {
                filename: documentInfo.source_filename,
                file_data: `data:application/pdf;base64,${base64Pdf}`,
              },
            },
            { type: 'text', text: userPrompt },
          ],
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: FACT_EXTRACTION_SCHEMA,
      },
      max_tokens: 8192,
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

    const result = JSON.parse(content) as LlmFactExtractionResult;
    result.facts = result.facts || [];
    result.warnings = result.warnings || [];

    logger.info('OpenAI vision fact extraction complete', {
      model,
      request_id: requestId,
      duration_seconds: duration,
      fact_count: result.facts.length,
    });

    return { result, requestId, model };
  } catch (error) {
    const duration = (Date.now() - startTime) / 1000;
    llmRequestDurationHistogram.observe({ model }, duration);
    llmRequestsCounter.inc({ model, status: 'error' });

    logger.error('OpenAI vision fact extraction failed', error, {
      model,
      document_id: documentInfo.document_id,
    });

    throw error;
  }
}

/**
 * Merge text facts with vision facts (concatenate; vision adds or replaces when text failed)
 */
export function mergeFacts(
  textFacts: { facts: any[] } | undefined,
  visionResult: LlmFactExtractionResult
): LlmFactExtractionResult {
  if (!textFacts?.facts?.length) {
    return visionResult;
  }
  return {
    facts: [...textFacts.facts, ...visionResult.facts],
    warnings: visionResult.warnings,
  };
}

/**
 * Build FactExtractionResult from merged LLM output
 */
export function buildFactExtractionResult(
  llmResult: LlmFactExtractionResult,
  documentInfo: DocumentInfo,
  correlationId: string,
  model: string,
  requestId: string
): FactExtractionResult {
  const facts: Fact[] = (llmResult.facts || []).map((f: { fact_type: string; value: unknown; evidence: Evidence[]; names_in_proximity: NameInProximity[] }) => ({
    fact_type: f.fact_type as Fact['fact_type'],
    value: isRawFactValue(f.value) ? normalizeFactValue(f.fact_type, f.value) : (f.value as Fact['value']),
    evidence: f.evidence ?? [],
    names_in_proximity: f.names_in_proximity ?? [],
  }));
  return {
    schema_version: '2.0',
    correlation_id: correlationId,
    document: documentInfo,
    extraction_mode: 'pdf_fallback',
    facts,
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
