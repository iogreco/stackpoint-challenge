/**
 * Tax Return 1040 Extraction Patterns
 *
 * Regular expressions and patterns for extracting SSN, names, and addresses
 * from IRS Form 1040 tax returns.
 *
 * Form 1040 has fixed field positions that enable algorithmic extraction:
 * - "Your social security number" -> Primary taxpayer SSN
 * - "Spouse's social security number" -> Spouse SSN (for MFJ)
 * - Names appear before their respective SSN labels
 * - Address in known header section
 */

/**
 * Normalize SSN by removing dashes, spaces, and other separators
 */
export function normalizeSSN(ssn: string): string {
  return ssn.replace(/[\s-]/g, '');
}

/**
 * Format SSN as XXX-XX-XXXX
 */
export function formatSSN(ssn: string): string {
  const normalized = normalizeSSN(ssn);
  if (normalized.length !== 9) return ssn;
  return `${normalized.slice(0, 3)}-${normalized.slice(3, 5)}-${normalized.slice(5)}`;
}

/**
 * SSN pattern - matches 9 digits with optional dashes/spaces
 * Examples: 999-40-5000, 999 40 5000, 999405000
 */
const SSN_PATTERN = /\d{3}[\s-]?\d{2}[\s-]?\d{4}/;

/**
 * Pattern to detect 1040 header page
 */
export const HEADER_PAGE_PATTERN = /Individual\s+Income\s+Tax\s+Return/i;

/**
 * Pattern for tax year
 */
export const TAX_YEAR_PATTERN = /\b(20\d{2})\s+1040\b/;

/**
 * Extract primary taxpayer SSN.
 * Looks for "Your social security number" label followed by SSN on same or next line.
 *
 * Example text structure:
 * "Your first name and middle initial Last Name Your social security number"
 * "John"
 * "Homeowner 999 40 5000"
 * "If joint return, spouse's first name..."
 * "Mary"
 * "Homeowner 500 22 2000"
 */
export function extractPrimaryTaxpayerSSN(text: string): { ssn: string; quote: string } | null {
  const headerSection = text.slice(0, 2500);

  // Find "Your social security number" label
  const yourSsnIndex = headerSection.indexOf('Your social security number');
  if (yourSsnIndex === -1) return null;

  // Find the next "Spouse" label to know where primary taxpayer section ends
  const spouseLabelIndex = headerSection.indexOf('spouse', yourSsnIndex);
  const primarySection = spouseLabelIndex !== -1
    ? headerSection.slice(yourSsnIndex, spouseLabelIndex)
    : headerSection.slice(yourSsnIndex, yourSsnIndex + 200);

  // Look for SSN pattern in the primary section only
  const ssnMatch = primarySection.match(SSN_PATTERN);
  if (ssnMatch) {
    const ssn = formatSSN(ssnMatch[0]);
    const ssnIndex = primarySection.indexOf(ssnMatch[0]);
    const quote = primarySection.slice(0, Math.min(ssnIndex + ssnMatch[0].length + 20, 200)).trim();
    return { ssn, quote };
  }

  return null;
}

/**
 * Extract spouse SSN for married filing jointly returns.
 * Looks for "Spouse's social security number" label.
 */
export function extractSpouseSSN(text: string): { ssn: string; quote: string } | null {
  const headerSection = text.slice(0, 2500);

  // Look for spouse SSN label and extract SSN that follows
  // Pattern: "Spouse's social security number" or "spouse's social security number"
  // Note: Include all apostrophe variants (', ', ') - U+0027, U+2018, U+2019
  const spouseSsnLabelPattern = /Spouse['\u2018\u2019]?s?\s+social\s+security\s+number/i;
  const match = headerSection.match(spouseSsnLabelPattern);

  if (!match) return null;

  const labelIndex = headerSection.indexOf(match[0]);
  const afterLabel = headerSection.slice(labelIndex, labelIndex + 300);

  // Find SSN pattern after the label
  const ssnMatch = afterLabel.match(SSN_PATTERN);
  if (ssnMatch) {
    const ssn = formatSSN(ssnMatch[0]);
    const ssnIndex = afterLabel.indexOf(ssnMatch[0]);
    const quote = afterLabel.slice(0, Math.min(ssnIndex + ssnMatch[0].length + 20, 200)).trim();
    return { ssn, quote };
  }

  return null;
}

/**
 * Extract primary taxpayer name from 1040 header.
 * Name appears after "Your first name and middle initial" label.
 */
export function extractPrimaryTaxpayerName(text: string): { fullName: string; quote: string } | null {
  const headerSection = text.slice(0, 2500);

  // Look for pattern: "Your first name and middle initial Last Name"
  // followed by actual name on next line
  const nameAreaPattern = /Your\s+first\s+name\s+and\s+middle\s+initial\s+Last\s+[Nn]ame\s+Your\s+social\s+security\s+number[\s\S]{0,50}?\n([A-Z][a-z]+)\n([A-Z][a-z]+)/;

  const match = headerSection.match(nameAreaPattern);
  if (match) {
    const firstName = match[1];
    const lastName = match[2].split(/\s+\d/)[0]; // Remove SSN if on same line
    const fullName = `${firstName} ${lastName}`;
    const quote = match[0].slice(0, 200);
    return { fullName, quote };
  }

  // Alternative: Try to find name before SSN
  // Pattern: FirstName on one line, LastName SSN on next
  const altPattern = /Your\s+first\s+name[\s\S]{0,100}?\n([A-Z][a-z]+(?:\s+[A-Z]\.?)?)\n([A-Z][a-z]+)\s+\d{3}/;
  const altMatch = headerSection.match(altPattern);
  if (altMatch) {
    const firstName = altMatch[1];
    const lastName = altMatch[2];
    const fullName = `${firstName} ${lastName}`;
    const quote = altMatch[0].slice(0, 200);
    return { fullName, quote };
  }

  return null;
}

/**
 * Extract spouse name for married filing jointly returns.
 */
export function extractSpouseName(text: string): { fullName: string; quote: string } | null {
  const headerSection = text.slice(0, 2500);

  // Look for pattern: "If joint return, spouse's first name and middle initial Last Name"
  // followed by actual name on next line
  // Note: Include all apostrophe variants (', ', ') - U+0027, U+2018, U+2019
  const spouseNamePattern = /(?:If\s+joint\s+return,\s+)?[Ss]pouse['\u2018\u2019]?s?\s+first\s+name\s+and\s+middle\s+initial\s+Last\s+[Nn]ame[\s\S]{0,50}?\n([A-Z][a-z]+)\n([A-Z][a-z]+)/;

  const match = headerSection.match(spouseNamePattern);
  if (match) {
    const firstName = match[1];
    const lastName = match[2].split(/\s+\d/)[0]; // Remove SSN if on same line
    const fullName = `${firstName} ${lastName}`;
    const quote = match[0].slice(0, 200);
    return { fullName, quote };
  }

  // Alternative pattern
  const altPattern = /[Ss]pouse['\u2018\u2019]?s?\s+first\s+name[\s\S]{0,100}?\n([A-Z][a-z]+(?:\s+[A-Z]\.?)?)\n([A-Z][a-z]+)\s+\d{3}/;
  const altMatch = headerSection.match(altPattern);
  if (altMatch) {
    const firstName = altMatch[1];
    const lastName = altMatch[2];
    const fullName = `${firstName} ${lastName}`;
    const quote = altMatch[0].slice(0, 200);
    return { fullName, quote };
  }

  return null;
}

/**
 * Extract address from 1040 header.
 * Address appears after "Home address" label.
 */
export function extractAddress(text: string): {
  street1: string;
  city: string;
  state: string;
  zip: string;
  quote: string;
} | null {
  const headerSection = text.slice(0, 3000);

  // Look for address section
  // Pattern: "Home address (number and street)" followed by street address
  // then city, state, zip
  const addressAreaStart = headerSection.indexOf('Home address');
  if (addressAreaStart === -1) return null;

  const addressSection = headerSection.slice(addressAreaStart, addressAreaStart + 500);

  // Extract street address (first line after label, before "Apt")
  const streetMatch = addressSection.match(/Home\s+address[^\n]*\n([^\n]+)/i);
  if (!streetMatch) return null;

  // The street is on the line after the header
  let street1 = streetMatch[1].trim();

  // Clean up common artifacts
  street1 = street1.replace(/Apt\.?\s*No\.?.*$/i, '').trim();
  street1 = street1.replace(/Check here if.*$/i, '').trim();

  // Look for city, state, zip
  // Pattern: "City, town, or post office" followed by actual city, then state and zip
  const cityStateZipPattern = /(?:City,?\s+town|City,?\s+or\s+post\s+office)[^\n]*\n([A-Za-z\s]+)[\s,]+(\d{5}(?:-\d{4})?)\n([A-Z]{2})/i;
  const cityMatch = addressSection.match(cityStateZipPattern);

  if (!cityMatch) {
    // Alternative: look for state and zip on same or adjacent lines
    const altCityPattern = /\n([A-Za-z][A-Za-z\s]+)\s+(\d{5}(?:-\d{4})?)\n([A-Z]{2})\n/;
    const altMatch = addressSection.match(altCityPattern);
    if (altMatch) {
      const city = altMatch[1].trim();
      const zip = altMatch[2];
      const state = altMatch[3];
      const quote = addressSection.slice(0, 250).trim();
      return { street1, city, state, zip, quote };
    }
    return null;
  }

  const city = cityMatch[1].trim();
  const zip = cityMatch[2];
  const state = cityMatch[3];
  const quote = addressSection.slice(0, 250).trim();

  return { street1, city, state, zip, quote };
}

/**
 * Extract tax year from 1040 form
 */
export function extractTaxYear(text: string): number | null {
  const match = text.match(TAX_YEAR_PATTERN);
  if (match) {
    return parseInt(match[1], 10);
  }
  // Also look for "For the year" pattern
  const yearPattern = /For\s+the\s+year\s+Jan\.?\s*1[–-]Dec\.?\s*31,?\s*(20\d{2})/i;
  const altMatch = text.match(yearPattern);
  if (altMatch) {
    return parseInt(altMatch[1], 10);
  }
  return null;
}

/**
 * Detect if filing status is Married Filing Jointly
 */
export function isMarriedFilingJointly(text: string): boolean {
  const mfjPatterns = [
    /Married\s+filing\s+jointly/i,
    /If\s+joint\s+return/i,
  ];

  // Also check for spouse SSN presence as confirmation
  const hasSpouseSSN = extractSpouseSSN(text) !== null;

  for (const pattern of mfjPatterns) {
    if (pattern.test(text)) {
      return true;
    }
  }

  return hasSpouseSSN;
}

/**
 * Extracted income data (Adjusted Gross Income from Line 11)
 */
export interface ExtractedIncome {
  amount: number;
  sourceType: 'tax_return_1040';
  quote: string;
  pageNumber: number;
}

/**
 * Extract Adjusted Gross Income (AGI) from Form 1040 Line 11.
 *
 * Example text structure:
 * "Subtract line 10 from line 9. This is your adjusted gross income"
 * "under Standard 11 11 172,261"
 *
 * @param text - Page text content
 * @param pageNumber - Page number for evidence
 * @returns Extracted AGI or null if not found
 */
export function extractAdjustedGrossIncome(text: string, pageNumber: number): ExtractedIncome | null {
  // Look for AGI pattern: "adjusted gross income" followed by line 11 with amount
  // Pattern captures the area around "adjusted gross income" and line 11
  const agiPattern = /adjusted\s+gross\s+income[\s\S]{0,100}?11\s+11\s+([\d,]+)/i;
  const match = text.match(agiPattern);

  if (match) {
    const amountStr = match[1].replace(/,/g, '');
    const amount = parseFloat(amountStr);

    if (!isNaN(amount) && amount > 0) {
      const matchIndex = text.indexOf(match[0]);
      const quoteStart = Math.max(0, matchIndex - 50);
      const quoteEnd = Math.min(text.length, matchIndex + match[0].length + 50);
      const quote = text.slice(quoteStart, quoteEnd).trim();

      return {
        amount,
        sourceType: 'tax_return_1040',
        quote,
        pageNumber,
      };
    }
  }

  // Alternative pattern: Look for "11" followed by amount near "adjusted gross"
  const altPattern = /This\s+is\s+your\s+adjusted\s+gross\s+income[\s\S]{0,50}?11\s+([\d,]+)/i;
  const altMatch = text.match(altPattern);

  if (altMatch) {
    const amountStr = altMatch[1].replace(/,/g, '');
    const amount = parseFloat(amountStr);

    if (!isNaN(amount) && amount > 0) {
      const matchIndex = text.indexOf(altMatch[0]);
      const quote = text.slice(matchIndex, matchIndex + 150).trim();

      return {
        amount,
        sourceType: 'tax_return_1040',
        quote,
        pageNumber,
      };
    }
  }

  return null;
}

/**
 * Result of parsing a 1040 header page
 */
export interface Parsed1040Data {
  taxYear: number | null;
  primaryTaxpayer: {
    fullName: string;
    ssn: string;
    nameQuote: string;
    ssnQuote: string;
  } | null;
  spouse: {
    fullName: string;
    ssn: string;
    nameQuote: string;
    ssnQuote: string;
  } | null;
  address: {
    street1: string;
    city: string;
    state: string;
    zip: string;
    quote: string;
  } | null;
  agi: ExtractedIncome | null;
  isMarriedFilingJointly: boolean;
  pageNumber: number;
}

/**
 * Parse all data from a 1040 header page
 */
export function parse1040HeaderPage(text: string, pageNumber: number): Parsed1040Data {
  const taxYear = extractTaxYear(text);
  const mfj = isMarriedFilingJointly(text);

  // Extract primary taxpayer
  const primaryName = extractPrimaryTaxpayerName(text);
  const primarySSN = extractPrimaryTaxpayerSSN(text);

  let primaryTaxpayer: Parsed1040Data['primaryTaxpayer'] = null;
  if (primaryName && primarySSN) {
    primaryTaxpayer = {
      fullName: primaryName.fullName,
      ssn: primarySSN.ssn,
      nameQuote: primaryName.quote,
      ssnQuote: primarySSN.quote,
    };
  }

  // Extract spouse if MFJ
  let spouse: Parsed1040Data['spouse'] = null;
  if (mfj) {
    const spouseName = extractSpouseName(text);
    const spouseSSN = extractSpouseSSN(text);
    if (spouseName && spouseSSN) {
      spouse = {
        fullName: spouseName.fullName,
        ssn: spouseSSN.ssn,
        nameQuote: spouseName.quote,
        ssnQuote: spouseSSN.quote,
      };
    }
  }

  // Extract address
  const address = extractAddress(text);

  // Extract Adjusted Gross Income (Line 11)
  const agi = extractAdjustedGrossIncome(text, pageNumber);

  return {
    taxYear,
    primaryTaxpayer,
    spouse,
    address,
    agi,
    isMarriedFilingJointly: mfj,
    pageNumber,
  };
}
