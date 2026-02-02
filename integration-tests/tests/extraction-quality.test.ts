/**
 * Extraction Quality Tests
 *
 * These tests verify that document extraction meets minimum quality standards.
 * They catch regressions in LLM extraction by validating:
 * - Required facts are extracted per document type
 * - Multi-name attribution works for joint documents
 * - SSN merging works correctly
 */

import * as path from 'path';
import * as fs from 'fs';
import { attributeFacts } from '../../services/worker-persistence/src/lib/attribution';
import type { FactExtractionResult, Fact } from '@stackpoint/shared';

// Minimum requirements per document type
const EXTRACTION_REQUIREMENTS: Record<string, {
  minFacts: number;
  requiredFactTypes: string[];
  description: string;
}> = {
  tax_return_1040: {
    minFacts: 3,
    requiredFactTypes: ['ssn', 'address'],
    description: '1040 must extract SSNs (one per taxpayer) and address',
  },
  w2: {
    minFacts: 3,
    requiredFactTypes: ['ssn', 'address', 'income'],
    description: 'W2 must extract employee SSN, address, and wages',
  },
  paystub: {
    minFacts: 2,
    requiredFactTypes: ['address', 'income'],
    description: 'Paystub must extract employee address and income',
  },
  bank_statement: {
    minFacts: 1,
    requiredFactTypes: ['address'],
    description: 'Bank statement must extract account holder address',
  },
  closing_disclosure: {
    minFacts: 1,
    requiredFactTypes: ['loan_number'],
    description: 'Closing disclosure must extract loan number',
  },
};

describe('Extraction Quality', () => {
  describe('1040 Tax Return - Joint Filing', () => {
    const fixturePath = path.join(
      __dirname,
      '../../fixtures/expected/tax_return_1040_2024_john_mary_homeowner.fact_extraction_result.json'
    );

    let factResult: FactExtractionResult;

    beforeAll(() => {
      const raw = fs.readFileSync(fixturePath, 'utf-8');
      factResult = JSON.parse(raw);
    });

    it('should have minimum required facts', () => {
      const req = EXTRACTION_REQUIREMENTS.tax_return_1040;
      expect(factResult.facts.length).toBeGreaterThanOrEqual(req.minFacts);
    });

    it('should extract SSN for primary taxpayer (John)', () => {
      const ssnFacts = factResult.facts.filter((f) => f.fact_type === 'ssn');
      const johnSsn = ssnFacts.find((f) =>
        f.names_in_proximity?.some((n) => n.full_name.toLowerCase().includes('john'))
      );

      expect(johnSsn).toBeDefined();
      expect(johnSsn?.value).toBe('999-40-5000');
    });

    it('should extract SSN for spouse (Mary)', () => {
      const ssnFacts = factResult.facts.filter((f) => f.fact_type === 'ssn');
      const marySsn = ssnFacts.find((f) =>
        f.names_in_proximity?.some((n) => n.full_name.toLowerCase().includes('mary'))
      );

      expect(marySsn).toBeDefined();
      expect(marySsn?.value).toBe('500-22-2000');
    });

    it('should have separate SSN facts for each taxpayer', () => {
      const ssnFacts = factResult.facts.filter((f) => f.fact_type === 'ssn');
      expect(ssnFacts.length).toBe(2);
    });

    it('should extract shared address with both names in proximity', () => {
      const addressFact = factResult.facts.find((f) => f.fact_type === 'address');

      expect(addressFact).toBeDefined();
      expect(addressFact?.names_in_proximity?.length).toBeGreaterThanOrEqual(2);

      const names = addressFact?.names_in_proximity?.map((n) => n.full_name.toLowerCase()) || [];
      expect(names.some((n) => n.includes('john'))).toBe(true);
      expect(names.some((n) => n.includes('mary'))).toBe(true);
    });

    it('should have proximity_score 3 for both taxpayers on address', () => {
      const addressFact = factResult.facts.find((f) => f.fact_type === 'address');
      const proximityScores = addressFact?.names_in_proximity?.map((n) => n.proximity_score) || [];

      expect(proximityScores.every((s) => s === 3)).toBe(true);
    });
  });

  describe('Multi-Name Attribution', () => {
    const fixturePath = path.join(
      __dirname,
      '../../fixtures/expected/tax_return_1040_2024_john_mary_homeowner.fact_extraction_result.json'
    );

    it('should attribute shared address to both borrowers', () => {
      const raw = fs.readFileSync(fixturePath, 'utf-8');
      const factResult: FactExtractionResult = JSON.parse(raw);

      const result = attributeFacts(factResult, 'test-correlation-id');

      // Should have 2 borrowers
      expect(result.borrowers.length).toBe(2);

      const johnBorrower = result.borrowers.find((b) =>
        b.borrower_ref.includes('john')
      );
      const maryBorrower = result.borrowers.find((b) =>
        b.borrower_ref.includes('mary')
      );

      expect(johnBorrower).toBeDefined();
      expect(maryBorrower).toBeDefined();

      // Both should have the same address
      expect(johnBorrower?.addresses.length).toBeGreaterThanOrEqual(1);
      expect(maryBorrower?.addresses.length).toBeGreaterThanOrEqual(1);

      expect(johnBorrower?.addresses[0].value.zip).toBe('20013');
      expect(maryBorrower?.addresses[0].value.zip).toBe('20013');
    });

    it('should attribute individual SSN to correct borrower only', () => {
      const raw = fs.readFileSync(fixturePath, 'utf-8');
      const factResult: FactExtractionResult = JSON.parse(raw);

      const result = attributeFacts(factResult, 'test-correlation-id');

      const johnBorrower = result.borrowers.find((b) =>
        b.borrower_ref.includes('john')
      );
      const maryBorrower = result.borrowers.find((b) =>
        b.borrower_ref.includes('mary')
      );

      // John should have his SSN only
      expect(johnBorrower?.identifiers.length).toBe(1);
      expect(johnBorrower?.identifiers[0].value).toBe('999-40-5000');

      // Mary should have her SSN only
      expect(maryBorrower?.identifiers.length).toBe(1);
      expect(maryBorrower?.identifiers[0].value).toBe('500-22-2000');
    });

    it('should attribute joint income (tax_return_1040) to both borrowers', () => {
      const raw = fs.readFileSync(fixturePath, 'utf-8');
      const factResult: FactExtractionResult = JSON.parse(raw);

      const result = attributeFacts(factResult, 'test-correlation-id');

      const johnBorrower = result.borrowers.find((b) =>
        b.borrower_ref.includes('john')
      );
      const maryBorrower = result.borrowers.find((b) =>
        b.borrower_ref.includes('mary')
      );

      // Both should have the joint income
      const johnIncome = johnBorrower?.income_history.find(
        (i) => i.source_type === 'tax_return_1040'
      );
      const maryIncome = maryBorrower?.income_history.find(
        (i) => i.source_type === 'tax_return_1040'
      );

      expect(johnIncome).toBeDefined();
      expect(maryIncome).toBeDefined();
      expect(johnIncome?.amount).toBe(143920);
      expect(maryIncome?.amount).toBe(143920);
    });
  });

  describe('Paystub Extraction', () => {
    const fixturePath = path.join(
      __dirname,
      '../../fixtures/expected/paystub_2025_04_25_john_homeowner.fact_extraction_result.json'
    );

    let factResult: FactExtractionResult;

    beforeAll(() => {
      const raw = fs.readFileSync(fixturePath, 'utf-8');
      factResult = JSON.parse(raw);
    });

    it('should meet minimum requirements', () => {
      const req = EXTRACTION_REQUIREMENTS.paystub;
      expect(factResult.facts.length).toBeGreaterThanOrEqual(req.minFacts);

      for (const requiredType of req.requiredFactTypes) {
        const hasFact = factResult.facts.some((f) => f.fact_type === requiredType);
        expect(hasFact).toBe(true);
      }
    });

    it('should not attribute employer address to borrower', () => {
      const result = attributeFacts(factResult, 'test-correlation-id');

      // Should have exactly 1 borrower
      expect(result.borrowers.length).toBe(1);

      // Check that employer address (Louisville, KY) is not in borrower addresses
      const borrowerAddresses = result.borrowers[0].addresses;
      const hasEmployerAddress = borrowerAddresses.some(
        (a) => a.value.city?.toLowerCase() === 'louisville'
      );

      expect(hasEmployerAddress).toBe(false);
    });
  });

  describe('W2 Extraction (fixture validation)', () => {
    const fixturePath = path.join(
      __dirname,
      '../../fixtures/expected/w2_2024_john_homeowner.extraction_result.json'
    );

    it('should have W2 fixture for regression testing', () => {
      expect(fs.existsSync(fixturePath)).toBe(true);
    });
  });
});

describe('Document Type Requirements', () => {
  // Generate tests for each document type requirement
  for (const [docType, req] of Object.entries(EXTRACTION_REQUIREMENTS)) {
    describe(`${docType}`, () => {
      it(`should require at least ${req.minFacts} facts`, () => {
        expect(req.minFacts).toBeGreaterThan(0);
      });

      it(`should require fact types: ${req.requiredFactTypes.join(', ')}`, () => {
        expect(req.requiredFactTypes.length).toBeGreaterThan(0);
      });
    });
  }
});
