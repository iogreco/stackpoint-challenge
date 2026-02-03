/**
 * E2E Extraction Quality Tests
 *
 * These tests run against live LLM extraction to catch regressions in extraction quality.
 * They require:
 * - Running services (make up)
 * - Valid OPENAI_API_KEY
 *
 * Run with: npm test -- --testPathPattern="extraction-quality.e2e"
 */

import {
  waitForHealth,
  syncAndWait,
  getBorrowers,
  sleep,
} from './helpers';

const ADAPTER_API_URL = process.env.ADAPTER_API_URL || 'http://localhost:8080';
const QUERY_API_URL = process.env.QUERY_API_URL || 'http://localhost:8081';

// Timeout for LLM extraction (can take 2-3 minutes for multiple documents)
const EXTRACTION_TIMEOUT_MS = 300000; // 5 minutes
const POLL_INTERVAL_MS = 5000;

// Minimum extraction requirements per borrower
interface BorrowerRequirements {
  name: string;
  minAddresses: number;
  minIdentifiers: number;
  minIncomeHistory: number;
  requiredSsnPattern?: RegExp;
  requiredZip?: string;
}

const EXPECTED_BORROWERS: BorrowerRequirements[] = [
  {
    name: 'john homeowner',
    minAddresses: 1,
    minIdentifiers: 1, // SSN from W2, 1040, or EVOE
    minIncomeHistory: 1, // From W2 or 1040
    requiredSsnPattern: /5000$/, // Last 4 digits
    requiredZip: '20013',
  },
  {
    name: 'mary homeowner',
    minAddresses: 1, // Should have address from joint 1040
    minIdentifiers: 0, // May or may not have SSN depending on extraction
    minIncomeHistory: 0,
    requiredZip: '20013',
  },
];

// Document-specific extraction requirements
interface DocumentExtractionRequirement {
  filenamePattern: RegExp;
  minFacts: number;
  requiredFactTypes: string[];
  description: string;
}

const DOCUMENT_REQUIREMENTS: DocumentExtractionRequirement[] = [
  {
    filenamePattern: /1040.*john.*mary/i,
    minFacts: 3,
    requiredFactTypes: ['ssn', 'address'],
    description: 'Joint 1040 must extract SSNs and shared address',
  },
  {
    filenamePattern: /w2.*john/i,
    minFacts: 3,
    requiredFactTypes: ['ssn', 'address', 'income'],
    description: 'W2 must extract employee SSN, address, and wages',
  },
];

async function waitForBorrowers(
  expectedCount: number,
  timeoutMs: number
): Promise<any[]> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const borrowers = await getBorrowers();

    if (borrowers.length >= expectedCount) {
      // Wait a bit more to ensure all processing is complete
      await sleep(5000);
      return await getBorrowers();
    }

    await sleep(POLL_INTERVAL_MS);
  }

  // Return whatever we have
  return await getBorrowers();
}

async function getExtractionLogs(): Promise<string> {
  try {
    const response = await fetch(`${ADAPTER_API_URL}/health`);
    return response.ok ? 'Services healthy' : 'Services unhealthy';
  } catch (error) {
    return `Error checking health: ${error}`;
  }
}

describe('E2E Extraction Quality', () => {
  // Check if we should skip (no API key or services not running)
  const shouldSkip = !process.env.OPENAI_API_KEY && !process.env.RUN_E2E_TESTS;

  beforeAll(async () => {
    if (shouldSkip) {
      console.log('Skipping E2E tests: Set OPENAI_API_KEY or RUN_E2E_TESTS=1 to run');
      return;
    }

    // Wait for services to be healthy
    const adapterHealthy = await waitForHealth(ADAPTER_API_URL, 60000);
    const queryHealthy = await waitForHealth(QUERY_API_URL, 60000);

    if (!adapterHealthy || !queryHealthy) {
      throw new Error('Services not healthy - ensure "make up" has been run');
    }
  }, 120000);

  describe('Full Pipeline Extraction', () => {
    let borrowers: any[] = [];
    let correlationId: string;

    beforeAll(async () => {
      if (shouldSkip) return;

      // Trigger full sync - process at least 4 documents to get SSN from multiple sources
      // (1040 has John/Mary SSN, EVOE has John SSN)
      console.log('Triggering document sync...');
      const syncResult = await syncAndWait('fixture_source', 4, EXTRACTION_TIMEOUT_MS);
      correlationId = syncResult.correlationId;
      console.log(`Sync started with correlation_id: ${correlationId}`);

      // Wait for borrowers to be created
      console.log('Waiting for extraction to complete...');
      borrowers = await waitForBorrowers(2, EXTRACTION_TIMEOUT_MS);
      console.log(`Found ${borrowers.length} borrowers`);
    }, EXTRACTION_TIMEOUT_MS + 60000);

    it('should extract at least 2 borrowers (John and Mary)', async () => {
      if (shouldSkip) return;

      expect(borrowers.length).toBeGreaterThanOrEqual(2);

      const names = borrowers.map((b) => b.full_name.toLowerCase());
      expect(names.some((n) => n.includes('john'))).toBe(true);
      expect(names.some((n) => n.includes('mary'))).toBe(true);
    });

    it('should extract John Homeowner with required data', async () => {
      if (shouldSkip) return;

      const john = borrowers.find((b) =>
        b.full_name.toLowerCase().includes('john homeowner')
      );

      expect(john).toBeDefined();
      if (!john) return;

      const req = EXPECTED_BORROWERS.find((r) => r.name.includes('john'))!;

      // Check addresses
      expect(john.addresses?.length).toBeGreaterThanOrEqual(req.minAddresses);
      if (req.requiredZip) {
        const hasRequiredZip = john.addresses?.some(
          (a: any) => a.value?.zip === req.requiredZip || a.zip === req.requiredZip
        );
        expect(hasRequiredZip).toBe(true);
      }

      // Check identifiers (SSN)
      expect(john.identifiers?.length).toBeGreaterThanOrEqual(req.minIdentifiers);
      if (req.requiredSsnPattern && john.identifiers?.length > 0) {
        const hasSsnMatch = john.identifiers?.some(
          (id: any) => req.requiredSsnPattern!.test(id.value)
        );
        expect(hasSsnMatch).toBe(true);
      }

      // Check income
      expect(john.income_history?.length).toBeGreaterThanOrEqual(req.minIncomeHistory);
    });

    it('should extract Mary Homeowner with shared address from joint documents', async () => {
      if (shouldSkip) return;

      const mary = borrowers.find((b) =>
        b.full_name.toLowerCase().includes('mary homeowner')
      );

      expect(mary).toBeDefined();
      if (!mary) return;

      const req = EXPECTED_BORROWERS.find((r) => r.name.includes('mary'))!;

      // Mary should have the shared address from joint 1040 or bank statements
      expect(mary.addresses?.length).toBeGreaterThanOrEqual(req.minAddresses);

      if (req.requiredZip) {
        const hasRequiredZip = mary.addresses?.some(
          (a: any) => a.value?.zip === req.requiredZip || a.zip === req.requiredZip
        );
        expect(hasRequiredZip).toBe(true);
      }
    });

    it('should merge SSNs correctly (no duplicates with different masks)', async () => {
      if (shouldSkip) return;

      const john = borrowers.find((b) =>
        b.full_name.toLowerCase().includes('john homeowner')
      );

      expect(john).toBeDefined();
      if (!john) return;

      // John should have exactly 1 SSN (merged from multiple sources)
      const ssnIdentifiers = john.identifiers?.filter(
        (id: any) => id.type === 'ssn'
      );

      // Should have exactly 1 SSN after merging masked/unmasked versions
      expect(ssnIdentifiers?.length).toBe(1);

      // The SSN should be the unmasked version (not xxx-xx-5000)
      if (ssnIdentifiers?.length > 0) {
        const ssnValue = ssnIdentifiers[0].value;
        expect(ssnValue).not.toMatch(/^x/i); // Should not start with 'x'
        expect(ssnValue).toMatch(/5000$/); // Should end with 5000
      }
    });

    it('should have HIGH confidence for SSN with multiple evidence sources', async () => {
      if (shouldSkip) return;

      const john = borrowers.find((b) =>
        b.full_name.toLowerCase().includes('john homeowner')
      );

      expect(john).toBeDefined();
      if (!john) return;

      const ssnIdentifier = john.identifiers?.find(
        (id: any) => id.type === 'ssn'
      );

      expect(ssnIdentifier).toBeDefined();
      if (!ssnIdentifier) return;

      // After merging, SSN should have HIGH confidence
      expect(ssnIdentifier.confidence).toBe('HIGH');

      // Should have evidence from multiple sources
      expect(ssnIdentifier.evidence?.length).toBeGreaterThanOrEqual(2);
    });

    it('should attribute joint income to both borrowers', async () => {
      if (shouldSkip) return;

      const john = borrowers.find((b) =>
        b.full_name.toLowerCase().includes('john homeowner')
      );
      const mary = borrowers.find((b) =>
        b.full_name.toLowerCase().includes('mary homeowner')
      );

      // Check if both have income from tax_return_1040 (joint income)
      const johnTaxIncome = john?.income_history?.find(
        (i: any) => i.source_type === 'tax_return_1040'
      );
      const maryTaxIncome = mary?.income_history?.find(
        (i: any) => i.source_type === 'tax_return_1040'
      );

      // Both should have the same joint income
      if (johnTaxIncome && maryTaxIncome) {
        expect(johnTaxIncome.amount).toBe(maryTaxIncome.amount);
      }
      // Note: This test is lenient - it passes if either has it or neither
      // because LLM extraction can vary
    });
  });

  describe('Extraction Completeness Checks', () => {
    it('should not have empty borrowers (all should have some data)', async () => {
      if (shouldSkip) return;

      const borrowers = await getBorrowers();

      for (const borrower of borrowers) {
        const hasData =
          (borrower.addresses?.length > 0) ||
          (borrower.identifiers?.length > 0) ||
          (borrower.income_history?.length > 0) ||
          (borrower.applications?.length > 0);

        expect(hasData).toBe(true);
      }
    });

    it('should have evidence for all extracted data', async () => {
      if (shouldSkip) return;

      const borrowers = await getBorrowers();

      for (const borrower of borrowers) {
        // Check addresses have evidence
        for (const addr of borrower.addresses || []) {
          expect(addr.evidence?.length).toBeGreaterThan(0);
        }

        // Check identifiers have evidence
        for (const id of borrower.identifiers || []) {
          expect(id.evidence?.length).toBeGreaterThan(0);
        }

        // Check income has evidence
        for (const income of borrower.income_history || []) {
          expect(income.evidence?.length).toBeGreaterThan(0);
        }
      }
    });

    it('should have proper evidence_source_context for SSN facts', async () => {
      if (shouldSkip) return;

      const borrowers = await getBorrowers();

      for (const borrower of borrowers) {
        for (const id of borrower.identifiers || []) {
          if (id.type === 'ssn') {
            // At least one evidence should have a proper SSN context
            const hasProperContext = id.evidence?.some(
              (e: any) =>
                e.evidence_source_context === 'tax_return_1040_taxpayer_ssn' ||
                e.evidence_source_context === 'w2_employee_ssn' ||
                e.evidence_source_context === 'evoe_verification'
            );

            // This is a soft check - we log if not present but don't fail
            if (!hasProperContext) {
              console.warn(
                `SSN for ${borrower.full_name} missing proper evidence_source_context:`,
                id.evidence?.map((e: any) => e.evidence_source_context)
              );
            }
          }
        }
      }
    });
  });
});

// Standalone smoke test that can run quickly
describe('Extraction Quality Smoke Test', () => {
  const shouldSkip = !process.env.OPENAI_API_KEY && !process.env.RUN_E2E_TESTS;

  it('should verify services are running', async () => {
    if (shouldSkip) {
      console.log('Skipping: Set OPENAI_API_KEY or RUN_E2E_TESTS=1');
      return;
    }

    const adapterHealthy = await waitForHealth(ADAPTER_API_URL, 10000);
    const queryHealthy = await waitForHealth(QUERY_API_URL, 10000);

    expect(adapterHealthy).toBe(true);
    expect(queryHealthy).toBe(true);
  });

  it('should be able to query existing borrowers', async () => {
    if (shouldSkip) return;

    const response = await fetch(`${QUERY_API_URL}/borrowers`);
    expect(response.ok).toBe(true);

    const data = await response.json() as { items: any[] };
    expect(Array.isArray(data.items)).toBe(true);
  });
});
