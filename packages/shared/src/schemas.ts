/**
 * JSON Schema Validation
 *
 * Schema validation using Ajv for extraction results and records.
 */

import fs from 'fs';
import path from 'path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { logger } from './logger';

// Initialize Ajv with 2020-12 draft support
const ajv = new Ajv2020({
  strict: false, // Allow additional keywords from JSON Schema draft
  allErrors: true,
  verbose: true,
});
addFormats(ajv);

// Schema loading - lazy loaded on first use
let extractionResultSchema: object | null = null;
let borrowerRecordSchema: object | null = null;
let applicationRecordSchema: object | null = null;

function loadSchema(schemaName: string): object {
  // Try multiple paths for schema resolution
  const possiblePaths = [
    // Relative to shared package in development
    path.join(__dirname, '../../../docs/contracts', schemaName),
    // Relative to shared package dist
    path.join(__dirname, '../../../../docs/contracts', schemaName),
    // Relative to project root (for Docker containers)
    path.join(process.cwd(), 'docs/contracts', schemaName),
    // Absolute path fallback
    `/app/docs/contracts/${schemaName}`,
  ];

  for (const schemaPath of possiblePaths) {
    try {
      if (fs.existsSync(schemaPath)) {
        const content = fs.readFileSync(schemaPath, 'utf-8');
        return JSON.parse(content);
      }
    } catch {
      // Try next path
    }
  }

  // Return a permissive schema if file not found (for container environments)
  logger.warn(`Schema file not found: ${schemaName}, using permissive validation`);
  return { type: 'object' };
}

function getExtractionResultSchema(): object {
  if (!extractionResultSchema) {
    extractionResultSchema = loadSchema('extraction_result.schema.json');
  }
  return extractionResultSchema;
}

function getBorrowerRecordSchema(): object {
  if (!borrowerRecordSchema) {
    borrowerRecordSchema = loadSchema('borrower_record.schema.json');
  }
  return borrowerRecordSchema;
}

function getApplicationRecordSchema(): object {
  if (!applicationRecordSchema) {
    applicationRecordSchema = loadSchema('application_record.schema.json');
  }
  return applicationRecordSchema;
}

export interface ValidationResult {
  valid: boolean;
  errors?: string[];
}

/**
 * Validate an ExtractionResult (fact-based) against extraction_result.schema.json
 */
export function validateExtraction(data: unknown): ValidationResult {
  const schema = getExtractionResultSchema();
  const validate = ajv.compile(schema);
  const valid = validate(data);

  if (!valid) {
    const errors = validate.errors?.map((e) => `${e.instancePath || '/'}: ${e.message}`);
    logger.warn('ExtractionResult validation failed', { errors });
    return { valid: false, errors };
  }

  return { valid: true };
}

/**
 * Validate a BorrowerRecord against the schema
 */
export function validateBorrower(data: unknown): ValidationResult {
  const schema = getBorrowerRecordSchema();
  const validate = ajv.compile(schema);
  const valid = validate(data);

  if (!valid) {
    const errors = validate.errors?.map((e) => `${e.instancePath || '/'}: ${e.message}`);
    logger.warn('BorrowerRecord validation failed', { errors });
    return { valid: false, errors };
  }

  return { valid: true };
}

/**
 * Validate an ApplicationRecord against the schema
 */
export function validateApplication(data: unknown): ValidationResult {
  const schema = getApplicationRecordSchema();
  const validate = ajv.compile(schema);
  const valid = validate(data);

  if (!valid) {
    const errors = validate.errors?.map((e) => `${e.instancePath || '/'}: ${e.message}`);
    logger.warn('ApplicationRecord validation failed', { errors });
    return { valid: false, errors };
  }

  return { valid: true };
}

// Re-export schemas for use in LLM prompts
export const schemas = {
  get extractionResult() {
    return getExtractionResultSchema();
  },
  get borrowerRecord() {
    return getBorrowerRecordSchema();
  },
  get applicationRecord() {
    return getApplicationRecordSchema();
  },
};
