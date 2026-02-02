/**
 * Evidence source context weights for confidence scoring (matching-and-merge-spec §4.4).
 * Starter policy for the loan-doc corpus; tune as failure modes are observed.
 */

import type { EvidenceSourceContext } from './types';

/** Weight per evidence_source_context (typically 0.0–3.0). */
export const EVIDENCE_WEIGHTS: Record<EvidenceSourceContext, number> = {
  // Borrower address
  tax_return_1040_taxpayer_address_block: 3.0,
  w2_employee_address_block: 3.0,
  closing_disclosure_borrower_section: 3.0,
  bank_statement_account_holder_address_block: 2.0,
  paystub_employee_info_block: 2.0,
  paystub_header_employer_block: 0.25,
  w2_employer_address_block: 0.25,
  // Income amount
  w2_wages_boxes_annual: 3.0,
  tax_return_1040_schedule_c_net_profit: 3.0,
  paystub_ytd_rate_of_pay: 2.0,
  evoe_verification: 2.0,
  letter_of_explanation: 0.75,
  // Fallback
  other: 0.5,
};

/** Default weight when evidence_source_context is missing or unknown. */
export const DEFAULT_EVIDENCE_WEIGHT = 0.5;

/**
 * Get weight for an evidence item. Uses DEFAULT_EVIDENCE_WEIGHT for missing/unknown context.
 */
export function getEvidenceWeight(evidence_source_context?: EvidenceSourceContext | null): number {
  if (evidence_source_context && evidence_source_context in EVIDENCE_WEIGHTS) {
    return EVIDENCE_WEIGHTS[evidence_source_context as EvidenceSourceContext];
  }
  return DEFAULT_EVIDENCE_WEIGHT;
}
