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
  // Format page text once
  const pageText = formatPageText(pages);

  // STEP 1: Classify document type
  const classification = await classifyDocument(pageText, documentInfo);

  // STEP 2: Extract with document-specific template
  const extraction = await extractWithTemplate(pageText, documentInfo, classification.document_type);

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
