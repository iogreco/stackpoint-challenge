/**
 * Attribution unit tests: FactExtractionResult -> ExtractionResult
 */

import * as path from 'path';
import * as fs from 'fs';
import { attributeFacts } from '../../services/worker-persistence/src/lib/attribution';
import type { FactExtractionResult } from '@stackpoint/shared';

describe('Attribution', () => {
  it('should convert fact extraction result to borrower-centric result', () => {
    const fixturePath = path.join(__dirname, '../../fixtures/expected/paystub_2025_04_25_john_homeowner.fact_extraction_result.json');
    const raw = fs.readFileSync(fixturePath, 'utf-8');
    const factResult: FactExtractionResult = JSON.parse(raw);

    const result = attributeFacts(factResult, 'test-correlation-id');

    expect(result.schema_version).toBe('1.1.0');
    expect(result.borrowers).toHaveLength(1);
    expect(result.borrowers[0].borrower_ref).toBe('john homeowner');
    expect(result.borrowers[0].full_name.value).toBe('John Homeowner');
    expect(result.borrowers[0].zip.value).toBe('20013');
    expect(result.borrowers[0].addresses).toHaveLength(1);
    expect(result.borrowers[0].addresses[0].value.zip).toBe('20013');
    expect(result.borrowers[0].income_history).toHaveLength(1);
    expect(result.borrowers[0].income_history[0].amount).toBe(4900.0);
    expect(result.applications).toHaveLength(0);
  });
});
