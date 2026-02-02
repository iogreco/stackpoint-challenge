/**
 * Attribution layer: convert FactExtractionResult to ExtractionResult (borrower-centric).
 * Assigns each fact to a borrower_ref or application using proximity_score and evidence context.
 */

import {
  getEvidenceWeight,
  logger,
  type FactExtractionResult,
  type Fact,
  type NameInProximity,
  type ExtractionResult,
  type BorrowerExtraction,
  type ApplicationExtraction,
  type AddressExtraction,
  type AddressValue,
  type IncomeExtraction,
  type IncomePeriod,
  type IdentifierExtraction,
  type ApplicationParty,
  type Evidence,
  type DocumentInfo,
  type ExtractionMetadata,
  type FactIncomeValue,
} from '@stackpoint/shared';

function normalizeName(fullName: string): string {
  return fullName.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Weight for tie-breaking when proximity_score is equal (use name's first evidence context). */
function nameEvidenceWeight(nameEntry: NameInProximity): number {
  const first = nameEntry.evidence?.[0];
  return first ? getEvidenceWeight(first.evidence_source_context) : 0;
}

/** Choose best name for a borrower-scoped fact: highest proximity_score, then evidence weight. */
function chooseBestName(fact: Fact): NameInProximity | null {
  if (!fact.names_in_proximity?.length) return null;
  let best = fact.names_in_proximity[0];
  for (let i = 1; i < fact.names_in_proximity.length; i++) {
    const n = fact.names_in_proximity[i];
    if (n.proximity_score > best.proximity_score) best = n;
    else if (n.proximity_score === best.proximity_score) {
      if (nameEvidenceWeight(n) > nameEvidenceWeight(best)) best = n;
    }
  }
  return best;
}

/** Attach proximity_score (from chosen name) to each evidence entry for persistence and split logic. */
function evidenceWithProximity(evidence: Evidence[], proximityScore: number | undefined): Evidence[] {
  if (proximityScore === undefined) return evidence;
  return evidence.map((e) => ({ ...e, proximity_score: proximityScore }));
}

/**
 * Convert fact-based extraction result to borrower-centric ExtractionResult.
 * Persistence will then resolve borrower_ref (normalized name) to borrower_id and merge as today.
 */
export function attributeFacts(
  factResult: FactExtractionResult,
  correlationId: string
): ExtractionResult {
  const { document, facts, extraction_metadata, created_at } = factResult;
  const extraction_mode = factResult.extraction_mode;

  // --- Borrower-scoped facts: assign to borrower_ref (normalized name) ---
  const borrowerAddresses = new Map<string, AddressExtraction[]>();
  const borrowerIdentifiers = new Map<string, IdentifierExtraction[]>();
  const borrowerIncomes = new Map<string, IncomeExtraction[]>();
  const borrowerFullNames = new Map<string, string>();
  const borrowerZipEvidence = new Map<string, { zip: string; evidence: Evidence[] }>();

  for (const fact of facts) {
    if (fact.fact_type === 'address') {
      const value = fact.value;
      if (!value || typeof value !== 'object' || !('zip' in value)) continue;

      // Skip employer addresses - they belong to the employer, not the borrower
      // Evidence contexts like 'paystub_header_employer_block' or 'w2_employer_address_block'
      // indicate addresses from employer sections that shouldn't be attributed to borrowers
      const evidenceContext = fact.evidence?.[0]?.evidence_source_context ?? '';
      if (evidenceContext.includes('employer')) {
        logger.debug('Attribution: skipping employer address', {
          evidence_source_context: evidenceContext,
          address: value,
        });
        continue;
      }

      const nameEntry = chooseBestName(fact);
      const borrowerRef = nameEntry ? normalizeName(nameEntry.full_name) : null;
      if (!borrowerRef) continue;
      if (!borrowerFullNames.has(borrowerRef)) borrowerFullNames.set(borrowerRef, nameEntry!.full_name);
      const addr: AddressExtraction = {
        type: 'current',
        value: value as AddressValue,
        evidence: evidenceWithProximity(fact.evidence ?? [], nameEntry?.proximity_score),
      };
      const list = borrowerAddresses.get(borrowerRef) || [];
      list.push(addr);
      borrowerAddresses.set(borrowerRef, list);
      const zip = (value as AddressValue).zip;
      if (zip && !borrowerZipEvidence.has(borrowerRef))
        borrowerZipEvidence.set(borrowerRef, {
          zip,
          evidence: evidenceWithProximity(fact.evidence ?? [], nameEntry?.proximity_score),
        });
    } else if (fact.fact_type === 'ssn') {
      const nameEntry = chooseBestName(fact);
      const borrowerRef = nameEntry ? normalizeName(nameEntry.full_name) : null;
      if (!borrowerRef) continue;
      if (!borrowerFullNames.has(borrowerRef)) borrowerFullNames.set(borrowerRef, nameEntry!.full_name);
      const id: IdentifierExtraction = {
        type: 'ssn',
        value: fact.value as string,
        evidence: evidenceWithProximity(fact.evidence ?? [], nameEntry?.proximity_score),
      };
      const list = borrowerIdentifiers.get(borrowerRef) || [];
      list.push(id);
      borrowerIdentifiers.set(borrowerRef, list);
    } else if (fact.fact_type === 'income') {
      const v = fact.value;
      if (!v || typeof v !== 'object' || typeof (v as FactIncomeValue).amount !== 'number') continue;
      const nameEntry = chooseBestName(fact);
      const borrowerRef = nameEntry ? normalizeName(nameEntry.full_name) : null;
      if (!borrowerRef) continue;
      if (!borrowerFullNames.has(borrowerRef)) borrowerFullNames.set(borrowerRef, nameEntry!.full_name);
      const vv = v as FactIncomeValue;
      const period: IncomePeriod = {
        year: vv.period?.year ?? new Date().getFullYear(),
        start_date: vv.period?.start_date,
        end_date: vv.period?.end_date,
      };
      const inc: IncomeExtraction = {
        source_type: vv.source_type ?? 'other',
        employer: vv.employer,
        period,
        amount: vv.amount,
        currency: vv.currency ?? 'USD',
        frequency: vv.frequency,
        evidence: evidenceWithProximity(fact.evidence ?? [], nameEntry?.proximity_score),
      };
      const list = borrowerIncomes.get(borrowerRef) || [];
      list.push(inc);
      borrowerIncomes.set(borrowerRef, list);
    }
    // employer_name facts: omit from persistence for MVP (or could attach to next income fact)
  }

  // --- Collect all names from loan_number facts (so we create borrowers for parties with no other facts) ---
  for (const fact of facts) {
    if (fact.fact_type === 'loan_number') {
      for (const n of fact.names_in_proximity ?? []) {
        const ref = normalizeName(n.full_name);
        if (!borrowerFullNames.has(ref)) borrowerFullNames.set(ref, n.full_name);
      }
    }
  }

  // --- Build borrowers[] ---
  const borrowerRefs = new Set<string>();
  borrowerFullNames.forEach((_, ref) => borrowerRefs.add(ref));
  if (facts.length > 0 && borrowerRefs.size === 0) {
    logger.warn('Attribution: facts present but no names_in_proximity produced any borrower_ref; check that each fact has at least one name with proximity_score', {
      fact_count: facts.length,
      fact_types: facts.map((f) => f.fact_type),
    });
  }

  const docEvidence: Evidence[] = [
    {
      document_id: document.document_id,
      source_filename: document.source_filename,
      page_number: 1,
      quote: '(from document)',
    },
  ];
  const borrowers: BorrowerExtraction[] = [];
  for (const ref of borrowerRefs) {
    const fullName = borrowerFullNames.get(ref) ?? '';
    const zipEntry = borrowerZipEvidence.get(ref);
    const zip = zipEntry?.zip ?? '';
    const addresses = borrowerAddresses.get(ref) ?? [];
    const identifiers = borrowerIdentifiers.get(ref) ?? [];
    const income_history = borrowerIncomes.get(ref) ?? [];
    const firstEvidence: Evidence[] =
      addresses[0]?.evidence ?? identifiers[0]?.evidence ?? income_history[0]?.evidence ?? docEvidence;
    const zipEvidence = zipEntry?.evidence ?? firstEvidence;
    borrowers.push({
      borrower_ref: ref,
      full_name: { value: fullName, evidence: firstEvidence },
      zip: { value: zip, evidence: zipEvidence },
      addresses,
      income_history,
      identifiers,
      missing_fields: [],
    });
  }

  // --- Loan number facts: one application per loan_number, all names as parties ---
  const applications: ApplicationExtraction[] = [];
  let applicationIndex = 0;
  for (const fact of facts) {
    if (fact.fact_type !== 'loan_number') continue;
    applicationIndex++;
    const loanNumber = (fact.value as string) || '';
    const parties: ApplicationParty[] = [];
    const seenRefs = new Set<string>();
    for (const n of fact.names_in_proximity ?? []) {
      const ref = normalizeName(n.full_name);
      if (seenRefs.has(ref)) continue;
      seenRefs.add(ref);
      parties.push({ borrower_ref: ref, role: 'borrower' });
    }
    applications.push({
      application_ref: loanNumber || `application_${applicationIndex}`,
      loan_number: { value: loanNumber, evidence: fact.evidence },
      property_address: {
        value: { zip: '00000' },
        evidence: [],
      },
      parties,
      identifiers: [],
      missing_fields: [],
    });
  }

  const result: ExtractionResult = {
    schema_version: '1.1.0',
    correlation_id: correlationId,
    document: document as DocumentInfo,
    extraction_mode,
    applications,
    borrowers,
    missing_fields: [],
    warnings: factResult.warnings,
    extraction_metadata: extraction_metadata as ExtractionMetadata,
    created_at,
  };
  return result;
}
