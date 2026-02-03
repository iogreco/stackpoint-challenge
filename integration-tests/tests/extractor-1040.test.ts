/**
 * Tax Return 1040 Algorithmic Extractor Tests
 *
 * Tests the pattern matching and parsing for Form 1040 extraction.
 */

import {
  extractPrimaryTaxpayerSSN,
  extractSpouseSSN,
  extractPrimaryTaxpayerName,
  extractSpouseName,
  extractAddress,
  extractTaxYear,
  isMarriedFilingJointly,
  parse1040HeaderPage,
  parse1040Document,
  formatSSN,
  normalizeSSN,
  findHeaderPages,
} from '@stackpoint/shared';
import type { DocumentInfo, PageText } from '@stackpoint/shared';

// Sample 1040 text from actual PDF extraction
const SAMPLE_1040_PAGE_1 = `Department of the Treasury - Internal Revenue Service
2024
1040
US Individual Income Tax Return
OMB No. 1545-0074 IRS Use Only—Do not write or staple in this space.
Form
For the year Jan. 1–Dec. 31, 2024, or other tax year beginning 1/31 See separate instructions.
1/31 3 , 20 24
Your first name and middle initial Last Name Your social security number
John
Homeowner 999 40 5000
If joint return, spouse's first name and middle initial Last Name Spouse's social security number
Mary
Homeowner 500 22 2000
Home address (number and street). If you have a P.O. box, see instructions. Apt. No. Presidential Election Campaign
175 13th Street Check here if you, or your
spouse if filing jointly, want $3 to go
Zip Code
City, town, or post office. If you have a foreign address, also complete spaces below. State
to this fund. Checking a box below
Washington 20013
DC
Foreign Postal Code will not change your tax or refund.
Foreign country name Foreign province/state/county
You Spouse
Filing Status
Single Head of household (HOH)
Married filing jointly (even if only one had income)`;

const SAMPLE_1040_PAGE_2023 = `Department of the Treasury - Internal Revenue Service
2023
1040
US Individual Income Tax Return
OMB No. 1545-0074 IRS Use Only—Do not write or staple in this space.
Form
For the year Jan. 1–Dec. 31, 2023, or other tax year beginning 1/31 See separate instructions.
Your first name and middle initial Last Name Your social security number
John
Homeowner 999 40 5000
If joint return, spouse's first name and middle initial Last Name Spouse's social security number
Mary
Homeowner 500 22 2000
Home address (number and street). If you have a P.O. box, see instructions. Apt. No. Presidential Election Campaign
175 13th Street Check here if you, or your
Zip Code
City, town, or post office. If you have a foreign address, also complete spaces below. State
Washington 20013
DC`;

describe('1040 Patterns', () => {
  describe('SSN extraction', () => {
    it('should extract primary taxpayer SSN', () => {
      const result = extractPrimaryTaxpayerSSN(SAMPLE_1040_PAGE_1);

      expect(result).not.toBeNull();
      expect(result?.ssn).toBe('999-40-5000');
      expect(result?.quote).toContain('social security number');
    });

    it('should extract spouse SSN', () => {
      const result = extractSpouseSSN(SAMPLE_1040_PAGE_1);

      expect(result).not.toBeNull();
      expect(result?.ssn).toBe('500-22-2000');
      expect(result?.quote).toContain('Spouse');
    });

    it('should return null for spouse SSN on single filing', () => {
      const singleFilerText = `Your first name and middle initial Last Name Your social security number
John
Homeowner 999 40 5000
Home address (number and street)
123 Main Street
Filing Status
Single`;

      const result = extractSpouseSSN(singleFilerText);
      expect(result).toBeNull();
    });
  });

  describe('Name extraction', () => {
    it('should extract primary taxpayer name', () => {
      const result = extractPrimaryTaxpayerName(SAMPLE_1040_PAGE_1);

      expect(result).not.toBeNull();
      expect(result?.fullName).toBe('John Homeowner');
    });

    it('should extract spouse name', () => {
      const result = extractSpouseName(SAMPLE_1040_PAGE_1);

      expect(result).not.toBeNull();
      expect(result?.fullName).toBe('Mary Homeowner');
    });
  });

  describe('Address extraction', () => {
    it('should extract address from header', () => {
      const result = extractAddress(SAMPLE_1040_PAGE_1);

      expect(result).not.toBeNull();
      expect(result?.street1).toBe('175 13th Street');
      expect(result?.city).toBe('Washington');
      expect(result?.state).toBe('DC');
      expect(result?.zip).toBe('20013');
    });
  });

  describe('Tax year extraction', () => {
    it('should extract tax year 2024', () => {
      const year = extractTaxYear(SAMPLE_1040_PAGE_1);
      expect(year).toBe(2024);
    });

    it('should extract tax year 2023', () => {
      const year = extractTaxYear(SAMPLE_1040_PAGE_2023);
      expect(year).toBe(2023);
    });
  });

  describe('Filing status detection', () => {
    it('should detect married filing jointly', () => {
      expect(isMarriedFilingJointly(SAMPLE_1040_PAGE_1)).toBe(true);
    });

    it('should detect single filer', () => {
      const singleFilerText = `Filing Status
Single
Your social security number
999 40 5000`;

      // Has no spouse SSN, so should return false (based on SSN detection)
      expect(isMarriedFilingJointly(singleFilerText)).toBe(false);
    });
  });
});

describe('SSN formatting', () => {
  it('should normalize SSN with dashes', () => {
    expect(normalizeSSN('999-40-5000')).toBe('999405000');
  });

  it('should normalize SSN with spaces', () => {
    expect(normalizeSSN('999 40 5000')).toBe('999405000');
  });

  it('should normalize SSN without separators', () => {
    expect(normalizeSSN('999405000')).toBe('999405000');
  });

  it('should format SSN correctly', () => {
    expect(formatSSN('999405000')).toBe('999-40-5000');
    expect(formatSSN('999 40 5000')).toBe('999-40-5000');
    expect(formatSSN('999-40-5000')).toBe('999-40-5000');
  });
});

describe('1040 Header Page Parser', () => {
  it('should parse complete header page', () => {
    const parsed = parse1040HeaderPage(SAMPLE_1040_PAGE_1, 1);

    expect(parsed.taxYear).toBe(2024);
    expect(parsed.isMarriedFilingJointly).toBe(true);
    expect(parsed.pageNumber).toBe(1);

    expect(parsed.primaryTaxpayer).not.toBeNull();
    expect(parsed.primaryTaxpayer?.fullName).toBe('John Homeowner');
    expect(parsed.primaryTaxpayer?.ssn).toBe('999-40-5000');

    expect(parsed.spouse).not.toBeNull();
    expect(parsed.spouse?.fullName).toBe('Mary Homeowner');
    expect(parsed.spouse?.ssn).toBe('500-22-2000');

    expect(parsed.address).not.toBeNull();
    expect(parsed.address?.zip).toBe('20013');
  });
});

describe('1040 Document Parser', () => {
  it('should parse multi-year 1040 document with proper SSN attribution', () => {
    const pages: PageText[] = [
      { pageNumber: 1, text: SAMPLE_1040_PAGE_1 },
      { pageNumber: 7, text: SAMPLE_1040_PAGE_2023 },
    ];

    const docInfo: DocumentInfo = {
      document_id: 'test-doc-123',
      source_filename: '1040-test.pdf',
      raw_uri: 'file:///test.pdf',
      source_system: 'test',
      source_doc_id: 'test-123',
    };

    const { facts, warnings } = parse1040Document(pages, docInfo);

    // Should have deduplicated SSN facts (same SSN across years)
    const ssnFacts = facts.filter(f => f.fact_type === 'ssn');
    expect(ssnFacts.length).toBe(2); // John's SSN and Mary's SSN

    // John's SSN should ONLY have John in names_in_proximity
    const johnSsnFact = ssnFacts.find(f => f.value === '999-40-5000');
    expect(johnSsnFact).toBeDefined();
    expect(johnSsnFact?.names_in_proximity).toHaveLength(1);
    expect(johnSsnFact?.names_in_proximity[0].full_name).toBe('John Homeowner');
    expect(johnSsnFact?.names_in_proximity[0].proximity_score).toBe(3);

    // Mary's SSN should ONLY have Mary in names_in_proximity
    const marySsnFact = ssnFacts.find(f => f.value === '500-22-2000');
    expect(marySsnFact).toBeDefined();
    expect(marySsnFact?.names_in_proximity).toHaveLength(1);
    expect(marySsnFact?.names_in_proximity[0].full_name).toBe('Mary Homeowner');
    expect(marySsnFact?.names_in_proximity[0].proximity_score).toBe(3);

    // Address facts should have BOTH names (shared address)
    const addressFacts = facts.filter(f => f.fact_type === 'address');
    expect(addressFacts.length).toBeGreaterThanOrEqual(1);

    const addressFact = addressFacts[0];
    expect(addressFact.names_in_proximity.length).toBeGreaterThanOrEqual(2);

    const addressNames = addressFact.names_in_proximity.map(n => n.full_name);
    expect(addressNames).toContain('John Homeowner');
    expect(addressNames).toContain('Mary Homeowner');
  });

  it('should find header pages', () => {
    const pages: PageText[] = [
      { pageNumber: 1, text: SAMPLE_1040_PAGE_1 },
      { pageNumber: 2, text: 'Some other page content' },
      { pageNumber: 7, text: SAMPLE_1040_PAGE_2023 },
    ];

    const headerPages = findHeaderPages(pages);
    expect(headerPages.length).toBe(2);
    expect(headerPages[0].pageNumber).toBe(1);
    expect(headerPages[1].pageNumber).toBe(7);
  });
});

describe('Extractor Registry', () => {
  it('should have all extractors registered', () => {
    const {
      getRegisteredTypes,
      getAllExtractors,
      getExtractor,
    } = require('@stackpoint/shared');

    const types = getRegisteredTypes();
    expect(types).toContain('tax_return_1040');
    expect(types).toContain('w2');
    expect(types).toContain('paystub');
    expect(types).toContain('bank_statement');
    expect(types).toContain('closing_disclosure');
    expect(types).toContain('evoe');
    expect(types).toContain('transmittal_summary');
    expect(types).toContain('letter_of_explanation');
    expect(types).toContain('title_report');
    expect(types).toContain('unknown');

    const extractors = getAllExtractors();
    expect(extractors.length).toBe(10);
  });

  it('should return correct extractor for each type', () => {
    const { getExtractor } = require('@stackpoint/shared');

    const taxReturn = getExtractor('tax_return_1040');
    expect(taxReturn?.strategy).toBe('algorithmic');
    expect(taxReturn?.documentType).toBe('tax_return_1040');

    const titleReport = getExtractor('title_report');
    expect(titleReport?.strategy).toBe('skip');
    expect(titleReport?.documentType).toBe('title_report');

    const paystub = getExtractor('paystub');
    expect(paystub?.strategy).toBe('llm_only');
    expect(paystub?.documentType).toBe('paystub');
  });
});
