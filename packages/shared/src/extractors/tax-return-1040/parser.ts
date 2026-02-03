/**
 * Tax Return 1040 Parser
 *
 * Converts parsed 1040 data into extraction facts with proper SSN->name attribution.
 * Each SSN is attributed ONLY to its owner, solving the joint-filing attribution problem.
 * Also extracts income from wages (W-2) and Schedule C (business income).
 */

import type { Fact, Evidence, NameInProximity, DocumentInfo, AddressValue, FactIncomeValue } from '../../types';
import type { PageText } from '../llm-extraction';
import {
  parse1040HeaderPage,
  HEADER_PAGE_PATTERN,
  type Parsed1040Data,
  type ExtractedIncome,
} from './patterns';

/**
 * Algorithm version for tracking
 */
export const ALGORITHM_VERSION = '1.1.0';

/**
 * Find all 1040 header pages in the document
 */
export function findHeaderPages(pages: PageText[]): PageText[] {
  return pages.filter(page => HEADER_PAGE_PATTERN.test(page.text));
}

/**
 * Create evidence object
 */
function createEvidence(
  docInfo: DocumentInfo,
  pageNumber: number,
  quote: string,
  context: string
): Evidence {
  return {
    document_id: docInfo.document_id,
    source_filename: docInfo.source_filename,
    page_number: pageNumber,
    quote: quote.slice(0, 300),
    evidence_source_context: context as Evidence['evidence_source_context'],
  };
}

/**
 * Create name in proximity entry with max proximity score (owner)
 */
function createNameInProximity(
  fullName: string,
  docInfo: DocumentInfo,
  pageNumber: number,
  quote: string,
  context: string
): NameInProximity {
  return {
    full_name: fullName,
    evidence: [createEvidence(docInfo, pageNumber, quote, context)],
    proximity_score: 3, // Max score - same section
  };
}

/**
 * Build SSN fact with ONLY its owner in names_in_proximity.
 * This is the key to solving the attribution problem.
 */
function buildSsnFact(
  ssn: string,
  ownerName: string,
  docInfo: DocumentInfo,
  pageNumber: number,
  ssnQuote: string,
  nameQuote: string
): Fact {
  return {
    fact_type: 'ssn',
    value: ssn,
    evidence: [
      createEvidence(docInfo, pageNumber, ssnQuote, 'tax_return_1040_taxpayer_ssn'),
    ],
    names_in_proximity: [
      createNameInProximity(ownerName, docInfo, pageNumber, nameQuote, 'tax_return_1040_taxpayer_ssn'),
    ],
  };
}

/**
 * Build address fact with all taxpayers in names_in_proximity.
 * For MFJ returns, both spouses share the address.
 */
function buildAddressFact(
  address: Parsed1040Data['address'],
  taxpayers: Array<{ fullName: string; nameQuote: string }>,
  docInfo: DocumentInfo,
  pageNumber: number
): Fact | null {
  if (!address) return null;

  const addressValue: AddressValue = {
    street1: address.street1,
    street2: '',
    city: address.city,
    state: address.state,
    zip: address.zip,
  };

  return {
    fact_type: 'address',
    value: addressValue,
    evidence: [
      createEvidence(docInfo, pageNumber, address.quote, 'tax_return_1040_taxpayer_address_block'),
    ],
    names_in_proximity: taxpayers.map(tp =>
      createNameInProximity(tp.fullName, docInfo, pageNumber, tp.nameQuote, 'tax_return_1040_taxpayer_address_block')
    ),
  };
}

/**
 * Build income fact for Adjusted Gross Income (AGI).
 * For MFJ returns, AGI is joint income.
 */
function buildAgiFact(
  agi: ExtractedIncome,
  taxYear: number | null,
  taxpayers: Array<{ fullName: string; nameQuote: string }>,
  docInfo: DocumentInfo
): Fact {
  const incomeValue: FactIncomeValue = {
    amount: agi.amount,
    currency: 'USD',
    frequency: 'annual',
    period: {
      year: taxYear || new Date().getFullYear(),
      start_date: taxYear ? `${taxYear}-01-01` : '',
      end_date: taxYear ? `${taxYear}-12-31` : '',
    },
    employer: '', // AGI is total income, not employer-specific
    source_type: 'tax_return_1040',
  };

  return {
    fact_type: 'income',
    value: incomeValue,
    evidence: [
      createEvidence(docInfo, agi.pageNumber, agi.quote, 'other'),
    ],
    names_in_proximity: taxpayers.map(tp =>
      createNameInProximity(tp.fullName, docInfo, agi.pageNumber, tp.nameQuote, 'other')
    ),
  };
}

/**
 * Parse all 1040 pages and build facts
 */
export function parse1040Document(
  pages: PageText[],
  docInfo: DocumentInfo
): { facts: Fact[]; warnings: string[] } {
  const facts: Fact[] = [];
  const warnings: string[] = [];
  const processedYears = new Set<number>();

  // Find all header pages (multi-year documents may have multiple)
  const headerPages = findHeaderPages(pages);

  if (headerPages.length === 0) {
    warnings.push('No 1040 header pages found');
    return { facts, warnings };
  }

  for (const page of headerPages) {
    const parsed = parse1040HeaderPage(page.text, page.pageNumber);

    // Skip if we've already processed this tax year
    if (parsed.taxYear && processedYears.has(parsed.taxYear)) {
      continue;
    }
    if (parsed.taxYear) {
      processedYears.add(parsed.taxYear);
    }

    // Collect taxpayers for address attribution
    const taxpayers: Array<{ fullName: string; nameQuote: string }> = [];

    // Extract primary taxpayer SSN
    if (parsed.primaryTaxpayer) {
      const { fullName, ssn, ssnQuote, nameQuote } = parsed.primaryTaxpayer;

      // SSN fact - ONLY primary taxpayer in names_in_proximity
      facts.push(buildSsnFact(ssn, fullName, docInfo, page.pageNumber, ssnQuote, nameQuote));

      taxpayers.push({ fullName, nameQuote });
    } else {
      warnings.push(`Page ${page.pageNumber}: Could not extract primary taxpayer info`);
    }

    // Extract spouse SSN (if MFJ)
    if (parsed.spouse) {
      const { fullName, ssn, ssnQuote, nameQuote } = parsed.spouse;

      // SSN fact - ONLY spouse in names_in_proximity
      facts.push(buildSsnFact(ssn, fullName, docInfo, page.pageNumber, ssnQuote, nameQuote));

      taxpayers.push({ fullName, nameQuote });
    } else if (parsed.isMarriedFilingJointly) {
      warnings.push(`Page ${page.pageNumber}: MFJ return but could not extract spouse info`);
    }

    // Extract address (shared by all taxpayers)
    if (parsed.address && taxpayers.length > 0) {
      const addressFact = buildAddressFact(
        parsed.address,
        taxpayers,
        docInfo,
        page.pageNumber
      );
      if (addressFact) {
        facts.push(addressFact);
      }
    } else if (!parsed.address) {
      warnings.push(`Page ${page.pageNumber}: Could not extract address`);
    }

    // Extract Adjusted Gross Income (Line 11)
    if (parsed.agi && taxpayers.length > 0) {
      const agiFact = buildAgiFact(
        parsed.agi,
        parsed.taxYear,
        taxpayers,
        docInfo
      );
      facts.push(agiFact);
    } else if (!parsed.agi) {
      warnings.push(`Page ${page.pageNumber}: Could not extract Adjusted Gross Income`);
    }
  }

  // Deduplicate facts (same SSN or same address across years)
  const deduplicatedFacts = deduplicateFacts(facts);

  return { facts: deduplicatedFacts, warnings };
}

/**
 * Deduplicate facts - same value appearing multiple times
 * Keep the one with most evidence
 */
function deduplicateFacts(facts: Fact[]): Fact[] {
  const ssnFacts = new Map<string, Fact>();
  const addressFacts: Fact[] = [];
  const incomeFacts = new Map<string, Fact>();
  const otherFacts: Fact[] = [];

  for (const fact of facts) {
    if (fact.fact_type === 'ssn') {
      const ssnValue = fact.value as string;
      const existing = ssnFacts.get(ssnValue);

      if (!existing) {
        ssnFacts.set(ssnValue, fact);
      } else {
        // Merge evidence
        const mergedEvidence = [...existing.evidence, ...fact.evidence];
        const mergedNames = mergeNamesInProximity(existing.names_in_proximity, fact.names_in_proximity);
        ssnFacts.set(ssnValue, {
          ...existing,
          evidence: mergedEvidence,
          names_in_proximity: mergedNames,
        });
      }
    } else if (fact.fact_type === 'address') {
      // For addresses, check if same address already exists
      const addressValue = fact.value as AddressValue;
      const addressKey = `${addressValue.street1}|${addressValue.zip}`;

      const existingIndex = addressFacts.findIndex(f => {
        const v = f.value as AddressValue;
        return `${v.street1}|${v.zip}` === addressKey;
      });

      if (existingIndex === -1) {
        addressFacts.push(fact);
      } else {
        // Merge evidence and names
        const existing = addressFacts[existingIndex];
        addressFacts[existingIndex] = {
          ...existing,
          evidence: [...existing.evidence, ...fact.evidence],
          names_in_proximity: mergeNamesInProximity(existing.names_in_proximity, fact.names_in_proximity),
        };
      }
    } else if (fact.fact_type === 'income') {
      // For income, dedupe by amount + year + source_type
      const incomeValue = fact.value as FactIncomeValue;
      const incomeKey = `${incomeValue.amount}|${incomeValue.period.year}|${incomeValue.source_type}`;

      const existing = incomeFacts.get(incomeKey);
      if (!existing) {
        incomeFacts.set(incomeKey, fact);
      } else {
        // Merge evidence
        incomeFacts.set(incomeKey, {
          ...existing,
          evidence: [...existing.evidence, ...fact.evidence],
          names_in_proximity: mergeNamesInProximity(existing.names_in_proximity, fact.names_in_proximity),
        });
      }
    } else {
      otherFacts.push(fact);
    }
  }

  return [...ssnFacts.values(), ...addressFacts, ...incomeFacts.values(), ...otherFacts];
}

/**
 * Merge names in proximity, keeping highest score for each name
 */
function mergeNamesInProximity(
  existing: NameInProximity[],
  additional: NameInProximity[]
): NameInProximity[] {
  const byName = new Map<string, NameInProximity>();

  for (const name of existing) {
    byName.set(name.full_name, name);
  }

  for (const name of additional) {
    const existingName = byName.get(name.full_name);
    if (!existingName) {
      byName.set(name.full_name, name);
    } else if (name.proximity_score > existingName.proximity_score) {
      byName.set(name.full_name, {
        ...name,
        evidence: [...existingName.evidence, ...name.evidence],
      });
    } else {
      byName.set(name.full_name, {
        ...existingName,
        evidence: [...existingName.evidence, ...name.evidence],
      });
    }
  }

  return Array.from(byName.values());
}
