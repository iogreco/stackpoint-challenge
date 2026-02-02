/**
 * LLM Integration
 *
 * Calls OpenAI for structured data extraction from document text.
 * Uses facts-based extraction: emits facts with names_in_proximity and proximity_score.
 */

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
import type { PageText } from './pdf';

const PROMPT_VERSION = '3.0.0-facts';

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

const SYSTEM_PROMPT = `You are a document extraction specialist. Extract FACTS from loan documents. Do not assign facts to people; instead, for each fact list ALL full names that appear near it and assign a proximity_score (0-3).

FACT TYPES to extract:
- address: street1, street2, city, state, zip (borrower or employer address; use evidence_source_context to distinguish)
- ssn: SSN string (e.g. xxx-xx-5000 or full)
- income: amount, currency, frequency, period (year, start_date, end_date), employer, source_type (w2, paystub, evoe, etc.)
- loan_number: the loan number string (often in header)
- employer_name: employer or business name

For EACH fact you must provide:
1. value: an object with address, string_value, and income. Fill only the one that matches fact_type: for address fill address (street1, street2, city, state, zip) and use empty strings for string_value and default income (amount:0, currency:"USD", frequency:"unknown", period:{year:0, start_date:"", end_date:""}, employer:"", source_type:"other"). For ssn, loan_number, or employer_name fill string_value; use empty address and default income. For income fill income; use empty address and string_value "".
2. evidence: at least one entry with document_id, source_filename, page_number, quote, evidence_source_context
3. names_in_proximity: EVERY full name you see near this fact, each with:
   - full_name: as it appears (e.g. "John Homeowner")
   - evidence: where this name appears (document_id, source_filename, page_number, quote, evidence_source_context)
   - proximity_score: 0-3
     - 3 = same line (or same logical block) as the fact
     - 2 = within 1 line (above or below)
     - 1 = within 2-3 lines
     - 0 = farther than 2-3 lines (or irrelevant)
   Names beyond 2-3 lines from the fact get score 0.

EVIDENCE SOURCE CONTEXT (use in evidence.evidence_source_context):
Address: tax_return_1040_taxpayer_address_block, w2_employee_address_block, closing_disclosure_borrower_section, bank_statement_account_holder_address_block, paystub_employee_info_block, paystub_header_employer_block, w2_employer_address_block
Income: w2_wages_boxes_annual, tax_return_1040_schedule_c_net_profit, paystub_ytd_rate_of_pay, evoe_verification, letter_of_explanation
Use "other" when unclear.

DATA FORMATTING:
- Names: "First Last"
- ZIP: 5 digits or 5+4
- SSN: XXX-XX-XXXX
- Dates: YYYY-MM-DD
- State: 2-letter (e.g. DC, CA)
- Currency: USD

For loan_number facts: list all applicant/borrower names that appear on the document in names_in_proximity (even if far from the loan number; use score 0 if beyond 2-3 lines).`;

const USER_PROMPT_TEMPLATE = `Extract facts from this loan document.

DOCUMENT METADATA (use these exact values in all evidence):
- document_id: {{document_id}}
- source_filename: {{source_filename}}

DOCUMENT TEXT BY PAGE:
{{page_text}}

Return a facts array. Each fact must have fact_type, value, evidence (at least one), and names_in_proximity (all names near the fact with proximity_score 0-3).`;

export interface LlmFactExtractionResult {
  facts: any[];
  warnings?: string[];
}

/**
 * Call OpenAI to extract facts from document text using Structured Outputs
 */
export async function extractWithLlm(
  pages: PageText[],
  documentInfo: DocumentInfo,
  correlationId: string
): Promise<{ result: LlmFactExtractionResult; requestId: string; model: string }> {
  const model = process.env.LLM_MODEL_TEXT || config.llmModelText;

  const pageText = pages
    .map((p) => `--- Page ${p.pageNumber} ---\n${p.text}`)
    .join('\n\n');

  const userPrompt = USER_PROMPT_TEMPLATE
    .replace('{{document_id}}', documentInfo.document_id)
    .replace('{{source_filename}}', documentInfo.source_filename)
    .replace('{{page_text}}', pageText);

  logger.info('Calling OpenAI for fact extraction', {
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
      response_format: {
        type: 'json_schema',
        json_schema: FACT_EXTRACTION_SCHEMA,
      },
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

    logger.info('OpenAI fact extraction complete', {
      model,
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

    return { result, requestId, model };
  } catch (error) {
    const duration = (Date.now() - startTime) / 1000;
    llmRequestDurationHistogram.observe({ model }, duration);
    llmRequestsCounter.inc({ model, status: 'error' });

    logger.error('OpenAI fact extraction failed', error, {
      model,
      document_id: documentInfo.document_id,
    });

    throw error;
  }
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
 * Build FactExtractionResult from LLM output
 */
export function buildFactExtractionResult(
  llmResult: LlmFactExtractionResult,
  documentInfo: DocumentInfo,
  correlationId: string,
  model: string,
  requestId: string
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
