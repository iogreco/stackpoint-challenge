/**
 * LLM Integration
 *
 * Calls OpenAI for structured data extraction from document text.
 * Uses OpenAI's Structured Outputs feature to ensure schema compliance.
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

const PROMPT_VERSION = '2.0.0';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || config.openaiApiKey,
  timeout: config.llmRequestTimeoutMs,
});

/**
 * JSON Schema for OpenAI Structured Outputs
 * This defines the exact structure the LLM must return.
 */
const EXTRACTION_SCHEMA = {
  name: 'loan_document_extraction',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['applications', 'borrowers', 'missing_fields', 'warnings'],
    properties: {
      applications: {
        type: 'array',
        description: 'Loan/application data extracted from the document',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['application_ref', 'loan_number', 'property_address', 'parties', 'identifiers', 'missing_fields'],
          properties: {
            application_ref: {
              type: 'string',
              description: 'Unique reference like "application_1"',
            },
            loan_number: {
              type: 'object',
              additionalProperties: false,
              required: ['value', 'evidence'],
              properties: {
                value: { type: 'string', description: 'The loan number, or empty string if not found' },
                evidence: {
                  type: 'array',
                  items: { $ref: '#/$defs/evidence' },
                },
              },
            },
            property_address: {
              type: 'object',
              additionalProperties: false,
              required: ['value', 'evidence'],
              properties: {
                value: { $ref: '#/$defs/address_value' },
                evidence: {
                  type: 'array',
                  items: { $ref: '#/$defs/evidence' },
                },
              },
            },
            parties: {
              type: 'array',
              description: 'Link to borrowers via borrower_ref',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['borrower_ref', 'role'],
                properties: {
                  borrower_ref: { type: 'string', description: 'References a borrower_ref from the borrowers array' },
                  role: { type: 'string', enum: ['borrower', 'co_borrower', 'other'] },
                },
              },
            },
            identifiers: {
              type: 'array',
              items: { $ref: '#/$defs/identifier_extraction' },
            },
            missing_fields: {
              type: 'array',
              items: { $ref: '#/$defs/field_name' },
            },
          },
        },
      },
      borrowers: {
        type: 'array',
        description: 'Individual borrower data extracted from the document',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['borrower_ref', 'full_name', 'zip', 'addresses', 'income_history', 'identifiers', 'missing_fields'],
          properties: {
            borrower_ref: {
              type: 'string',
              description: 'Unique reference like "borrower_1", "borrower_2"',
            },
            full_name: {
              type: 'object',
              additionalProperties: false,
              required: ['value', 'evidence'],
              properties: {
                value: { type: 'string', description: 'Full name in "First Last" format' },
                evidence: {
                  type: 'array',
                  items: { $ref: '#/$defs/evidence' },
                },
              },
            },
            zip: {
              type: 'object',
              additionalProperties: false,
              required: ['value', 'evidence'],
              properties: {
                value: {
                  type: 'string',
                  description:
                    "ZIP code of the borrower's residence only (5 or 5+4 digits). Do NOT use the employer's business address ZIP from employment verification (EVOE/VOE) documents.",
                },
                evidence: {
                  type: 'array',
                  items: { $ref: '#/$defs/evidence' },
                },
              },
            },
            addresses: {
              type: 'array',
              description:
                "Borrower's residence addresses only. Exclude employer or business addresses (e.g. addresses under EMPLOYER section in EVOE/VOE).",
              items: { $ref: '#/$defs/address_extraction' },
            },
            income_history: {
              type: 'array',
              items: { $ref: '#/$defs/income_extraction' },
            },
            identifiers: {
              type: 'array',
              items: { $ref: '#/$defs/identifier_extraction' },
            },
            missing_fields: {
              type: 'array',
              items: { $ref: '#/$defs/field_name' },
            },
          },
        },
      },
      missing_fields: {
        type: 'array',
        description: 'Top-level fields that could not be extracted from this document',
        items: { $ref: '#/$defs/field_name' },
      },
      warnings: {
        type: 'array',
        description: 'Non-fatal warnings during extraction',
        items: { type: 'string' },
      },
    },
    $defs: {
      field_name: {
        type: 'string',
        enum: [
          'borrower.full_name',
          'borrower.zip',
          'borrower.addresses',
          'borrower.income_history',
          'borrower.identifiers',
          'application.loan_number',
          'application.property_address',
          'application.parties',
        ],
      },
      evidence: {
        type: 'object',
        additionalProperties: false,
        required: ['document_id', 'source_filename', 'page_number', 'quote'],
        properties: {
          document_id: { type: 'string', description: 'Use the exact document_id from input' },
          source_filename: { type: 'string', description: 'Use the exact source_filename from input' },
          page_number: { type: 'integer', description: '1-indexed page number' },
          quote: { type: 'string', description: 'Short quote (max 300 chars) supporting the extracted value' },
        },
      },
      address_value: {
        type: 'object',
        additionalProperties: false,
        required: ['street1', 'street2', 'city', 'state', 'zip'],
        properties: {
          street1: { type: 'string', description: 'Primary street address, or empty string if not found' },
          street2: { type: 'string', description: 'Secondary address (apt, suite), or empty string if none' },
          city: { type: 'string', description: 'City name, or empty string if not found' },
          state: { type: 'string', description: '2-letter state code, or empty string if not found' },
          zip: { type: 'string', description: '5 digits or 5+4 format, or empty string if not found' },
        },
      },
      address_extraction: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'value', 'evidence'],
        properties: {
          type: { type: 'string', enum: ['current', 'previous', 'mailing', 'property'] },
          value: { $ref: '#/$defs/address_value' },
          evidence: {
            type: 'array',
            items: { $ref: '#/$defs/evidence' },
          },
        },
      },
      income_extraction: {
        type: 'object',
        additionalProperties: false,
        required: ['source_type', 'employer', 'period', 'amount', 'currency', 'frequency', 'evidence'],
        properties: {
          source_type: {
            type: 'string',
            enum: ['w2', 'paystub', 'tax_return_1040', 'schedule_c', 'bank_statement', 'other'],
          },
          employer: { type: 'string', description: 'Employer name, or empty string if not applicable' },
          period: {
            type: 'object',
            additionalProperties: false,
            required: ['year', 'start_date', 'end_date'],
            properties: {
              year: { type: 'integer', description: 'Tax year or income year' },
              start_date: { type: 'string', description: 'ISO date YYYY-MM-DD, or empty string if unknown' },
              end_date: { type: 'string', description: 'ISO date YYYY-MM-DD, or empty string if unknown' },
            },
          },
          amount: { type: 'number', description: 'Income amount as a number' },
          currency: { type: 'string', description: '3-letter currency code, default USD' },
          frequency: {
            type: 'string',
            enum: ['annual', 'monthly', 'biweekly', 'weekly', 'daily', 'unknown'],
            description: 'How often this income is received',
          },
          evidence: {
            type: 'array',
            items: { $ref: '#/$defs/evidence' },
          },
        },
      },
      identifier_extraction: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'value', 'evidence'],
        properties: {
          type: { type: 'string', enum: ['loan_number', 'account_number', 'ssn', 'ein', 'other'] },
          value: { type: 'string', description: 'The identifier value (SSN in XXX-XX-XXXX format)' },
          evidence: {
            type: 'array',
            items: { $ref: '#/$defs/evidence' },
          },
        },
      },
    },
  },
} as const;

const SYSTEM_PROMPT = `You are a document extraction specialist. Extract structured data from loan documents.

EXTRACTION RULES:
1. Extract all borrower information: full name, addresses, income records, and identifiers (SSN, account numbers)
2. Extract all application/loan information: loan numbers, property addresses
3. Link borrowers to applications using the parties array

BORROWER ADDRESSES (critical):
- borrower.addresses and borrower.zip must be the BORROWER'S RESIDENCE (home/mailing address), not the employer's address.
- In employment verification documents (EVOE, VOE, etc.), the address under "EMPLOYER" or "Employer" is the employer's business address. Do NOT use it as the borrower's address.
- If the document only shows an employer address and no borrower residence, leave addresses [] and zip "" and add borrower.addresses (and borrower.zip if needed) to missing_fields.

EVIDENCE REQUIREMENTS:
- Every extracted value MUST have at least one evidence entry
- Use the EXACT document_id and source_filename provided in the input
- page_number is 1-indexed (first page is 1)
- quote must be a short snippet (under 300 chars) that directly supports the extracted value

DATA FORMATTING:
- Names: "First Last" format
- ZIP codes: 5 digits (12345) or 5+4 format (12345-6789)
- SSN: XXX-XX-XXXX format
- Income amounts: numbers (not strings)
- Dates: YYYY-MM-DD format
- State codes: 2-letter uppercase (e.g., "DC", "CA")
- Currency: 3-letter code (default "USD")

MISSING DATA:
- If a required field cannot be found, add it to missing_fields
- Use empty arrays [] for optional array fields with no data
- Use empty string "" for required string fields with no data found

BORROWER REFERENCES:
- Use "borrower_1", "borrower_2", etc. for borrower_ref
- Use "application_1", etc. for application_ref
- Reference borrowers in application.parties using their borrower_ref`;

const USER_PROMPT_TEMPLATE = `Extract data from this loan document.

DOCUMENT METADATA (use these exact values in evidence):
- document_id: {{document_id}}
- source_filename: {{source_filename}}

DOCUMENT TEXT BY PAGE:
{{page_text}}

Extract all borrowers and applications found. Include evidence for every extracted value.`;

export interface LlmExtractionResult {
  applications: any[];
  borrowers: any[];
  missing_fields: string[];
  warnings?: string[];
}

/**
 * Call OpenAI to extract data from document text using Structured Outputs
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

  logger.info('Calling OpenAI for extraction with structured outputs', {
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
        json_schema: EXTRACTION_SCHEMA,
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

    logger.info('OpenAI extraction complete', {
      model,
      request_id: requestId,
      duration_seconds: duration,
      tokens_used: response.usage?.total_tokens,
    });

    const result = JSON.parse(content) as LlmExtractionResult;

    // Debug: log raw LLM response for diagnostics
    logger.debug('LLM structured response', {
      document_id: documentInfo.document_id,
      borrower_count: result.borrowers?.length || 0,
      application_count: result.applications?.length || 0,
    });

    // Ensure required arrays exist (should already be guaranteed by schema)
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
  // Need fallback if we found no borrowers
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
