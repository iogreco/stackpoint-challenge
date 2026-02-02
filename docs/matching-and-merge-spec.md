# Matching and Merge Spec

This document defines the **logical rules** for matching an incoming borrower payload to an existing borrower record (or creating a new one) and for merging PII and personal data with confidence scoring. It is implementation-agnostic and does not prescribe a database schema.

---

## 1. Purpose and scope

### 1.1 Goals

- **Resilience to LLM inaccuracy**: Avoid creating duplicate borrower records when the LLM misattributes data (e.g., employer address as borrower address) or extracts the same person with slightly different values (e.g., different zip, partial SSN).
- **Single logical borrower per person**: For a given identity, there should be one borrower record that accumulates evidence from all documents.
- **Evidence preservation**: When the same PII appears in multiple documents, merge evidence into one logical element (e.g., one address, one SSN) instead of duplicating; prefer the most complete value (e.g., full SSN over obfuscated).
- **Confidence for prioritization**: Assign a confidence level to each merged element (address, identifier, income) so consumers can prefer high-confidence values (e.g., for display or downstream decisions).

### 1.2 Out of scope

- Database schema or table design (handled elsewhere).
- Read API contract (read-by-`borrower_id` is assumed; response shape is not specified here).

---

## 2. Matching: find existing borrower

When persisting an extraction result, each **borrower** in the payload must be resolved to either an **existing** borrower (by identity) or a **new** borrower. Matching uses the payload plus a query over existing records.

### 2.1 Candidate set

- **Rule (candidates)**: Query existing borrower records where **full name** matches the payload borrower’s full name.
- **Name normalization**: For comparison, normalize name: trim, lowercase, collapse internal spaces. Optional: split "First Last" and match on first + last to handle minor variants (e.g., "John A. Doe" vs "John Doe"); if not splitting, exact normalized string match is sufficient.
- **Optional scoping**: Restrict candidates to the same `correlation_id` or same application set to avoid merging across unrelated loans. If not scoped, matching relies on partial-match strength only.

### 2.2 Partial match signals

A **partial match** is any of the following between the payload borrower and a candidate existing borrower. Each signal can be used to increase match strength or to treat the candidate as "same" when combined with name match.

| Signal | Condition | Notes |
|--------|-----------|--------|
| **Identifier value** | Same identifier type and same value (after normalization). | e.g., account_number "12345" equals "12345". Normalize (trim, collapse spaces/dashes) as needed. |
| **SSN overlap** | Visible (non-obfuscated) digit positions agree. | e.g., `xxx-xx-5000` and `999-40-5000` both expose last-4 "5000" → overlap. If one is full SSN and the other is partial, the partial’s visible digits must equal the same positions in the full. Two full SSNs must be equal. |
| **Zip match** | Same 5-digit zip, or same 5-digit prefix when one or both are ZIP+4. | e.g., 20013 and 20013-1234 → match. |
| **Address meaningful portion** | Same after normalization: at least (city + state) or (street1 + city + state) or (zip + state). | Normalize: lowercase, collapse spaces, strip punctuation; optionally ignore apt/suite. "Meaningful" means enough to avoid false matches (e.g., same zip alone may be too weak; zip + state or city + state is stronger). |

### 2.3 Match decision (inverted: merge by default, split only on strong conflict)

- **Rule (match decision)**:
  - If there are **no candidates** (no existing borrower with same normalized name), **create a new borrower**.
  - Else, **merge by default**: treat the payload borrower as the **same** as a candidate (same normalized name) and use that candidate's borrower record for merge—**unless** adding this payload would introduce **strong conflicting evidence** (see below). In that case, **create a new borrower** (a second person with the same name).
  - **Strong conflicting evidence** (split only when present):
    - **SSN conflict**: The payload contains a **new** SSN (identifier type SSN) with **proximity_score 3** (see facts-based-extraction-spec §3.1) that does **not** overlap (e.g., different last-4 or full SSN) any existing SSN for that candidate. Then treat as a different person: create a new borrower.
    - **Address conflict**: The payload contains an address with **proximity_score ≥ 2** whose (city+state or zip+state) is **different** from all existing addresses for that candidate, and the candidate already has at least one address with **proximity_score ≥ 2**. Then treat as a different person: create a new borrower.
  - When multiple candidates exist and none have strong conflict, merge into one (e.g., the first such candidate); implementation may use partial-match signals to pick the best.

- **Proximity score**: Each evidence entry may carry a **proximity_score** (0–3) from the facts-based extraction (see `docs/facts-based-extraction-spec.md` §3.1). This score is used to decide **split**: only high-proximity conflicting SSN or address triggers creating a second borrower with the same name.

---

## 3. Merge semantics (PII and personal data)

Once the payload borrower is resolved to an existing borrower (or a new one), **addresses**, **identifiers**, and **income_history** from the payload must be merged into that borrower’s record. The principle: **do not duplicate** a logical fact; **add evidence** to an existing element when the incoming value matches, and **prefer the most complete value** when merging.

### 3.1 Addresses

- **Same address**: Two addresses are the **same** if, after normalization (lowercase, collapse spaces, strip punctuation), they agree on (street1, city, state, zip) or on a defined subset (e.g., city + state + zip) per implementation.
- **Rule (address merge)**:
  - For each address in the payload, check whether there exists an existing address for this borrower that is "same" (by the chosen rule).
  - If **same**: do not create a new address; **add the incoming evidence** (document_id, page_number, quote) to that existing address. Optionally update street/city/state/zip if the incoming value is strictly more complete (e.g., full street vs abbreviated).
  - If **no same**: add a **new** address with the incoming value and its evidence.

### 3.2 Identifiers (e.g., SSN)

- **Same identifier**: Two identifiers are the **same** if they have the same type (e.g., ssn) and their values **overlap** (for SSN: visible digits match; for others: normalized value match).
- **Rule (identifier merge)**:
  - For each identifier in the payload, check whether there exists an existing identifier for this borrower of the same type and overlapping value.
  - If **same/overlap**: do not create a new identifier; **add the incoming evidence** to that existing identifier. **Keep the most complete value** (e.g., full SSN over obfuscated `xxx-xx-5000`; if both partial, keep one and attach all evidence).
  - If **no same**: add a **new** identifier with the incoming value and its evidence.

### 3.3 Income history

Income history needs **stricter identity** than “employer + year” to avoid collisions (and to avoid incorrectly merging values that happen to share an employer name).

#### 3.3.1 Income identity key (required)

Define a deterministic **income_identity_key** for every income entry. At minimum:

- **source_type** *(required)*: e.g., `w2`, `paystub`, `evoe`, `schedule_c`, `tax_return_1040`, `bank_statement` (or whatever your system uses).
- **employer_norm** *(required when applicable)*: normalized employer name (trim, uppercase, collapse whitespace, strip punctuation, normalize common suffixes like INC/LLC if you do that elsewhere).
  - For self-employment, use the business name (e.g., Schedule C business name) or a stable label like `SELF_EMPLOYED:<business_norm>`.
- **period_key** *(required)*: one of:
  - `period_start|period_end` when you have explicit dates (preferred), else
  - `period_year` when the doc is annual (e.g., W-2, 1040), else
  - `as_of_date` for point-in-time verifications (if applicable).
- **income_kind** *(recommended)*: e.g., `wages_salary`, `bonus_commission`, `self_employment_net_profit`, `other`.

> If any required component is missing (e.g., employer absent and you cannot infer self-employment context), treat the income entry as **non-dedupable** and store it as a separate entry (still with evidence), rather than risking a bad merge.

#### 3.3.2 Same income (dedupe rule)

Two income entries are the **same** iff:

- `source_type` matches *(mandatory)*, AND
- `employer_norm` matches *(when applicable)*, AND
- `period_key` matches.

**Important:** `source_type` is no longer “optional.”  
If you want to reconcile across sources (e.g., W-2 wages vs EVOE annualized salary), do that as a **separate, explicit reconciliation step** (out of scope here) rather than merging them into one income record.

#### 3.3.3 Rule (income merge)

For each income in the payload:

1. Compute `income_identity_key`.
2. Look for an existing income entry for this borrower with the same `income_identity_key`.
3. If **same**:
   - Do **not** create a new income entry.
   - Add the incoming **evidence** to the existing income entry.
   - If the incoming amount differs, keep the existing canonical amount unless the incoming value is more authoritative (see Confidence Scoring weights in §4), in which case update the canonical amount and retain prior value in evidence/provenance.
4. If **no same**:
   - Add a **new** income entry with its value and evidence.

---
## 4. Confidence scoring (with document-type weighting)

After merge, each **element** (each address, each identifier, each income record) is assigned a **confidence level** so that consumers can prioritize (e.g., show HIGH first, or use only HIGH for critical decisions).

This version introduces **document-type weighting** so that repeated low-authority mentions do not overpower fewer high-authority mentions.

### 4.1 Definitions (per element, per conflict domain)

- **Element**: One logical address, one logical identifier (e.g., one SSN), or one logical income record (as defined by `income_identity_key`), for a given borrower.

- **Conflict domain**: The set of elements that can **compete** with each other.
  - For **identifiers**: all identifiers of the same identifier type (e.g., all SSNs).
  - For **addresses**: all addresses of the same address role/type (if you have roles), otherwise all addresses.
  - For **income**: all income elements with the same `income_identity_key` components (same employer/period/source). Incomes for different employers/periods do **not** compete.

- **Evidence**: A provenance reference supporting a value (document_id + location + optional context).

- **Evidence weight**: `w(evidence) ∈ ℝ+` (typically 0.0–3.0), derived from:
  - document type (W-2 vs paystub vs 1040 vs bank statement…),
  - field relevance (e.g., “employee address block” vs “employer header”),
  - optional context hints (nearby labels like “Employer”, “Employee”, “Borrower”, etc., if captured).

### 4.2 Weighted favorable and unfavorable support

For an element `E` in its conflict domain:

- **favorable_weight(E)**:  
  `Σ w(evidence)` for all evidence attached to `E`.

- **unfavorable_weight(E)**:  
  `Σ w(evidence)` for all evidence attached to *other* competing elements in the same conflict domain.

### 4.3 Score and confidence level

- **Score** (for element `E`):  
  `score(E) = favorable_weight(E) / max(unfavorable_weight(E), 1e-6)`

- **Confidence level** (default thresholds):
  - **HIGH**:   `score > 1`
  - **MEDIUM**: `score == 1` (or within a small epsilon)
  - **LOW**:    `score < 1`

Implementations may choose slightly different thresholds (e.g., HIGH if `score ≥ 1.25`) but must remain deterministic.

### 4.4 Suggested default weighting table (starter policy)

This is a **starter** policy for the loan-doc corpus; store it as config (e.g., YAML/JSON) and adjust as you observe failure modes.

| Field / Element | Evidence source context | Weight | Rationale |
|---|---:|---|
| Borrower address | Tax return (1040) taxpayer address block | 3.0 | High authority, borrower-centric |
| Borrower address | W-2 employee address block | 3.0 | High authority, explicitly employee |
| Borrower address | Closing Disclosure borrower section | 3.0 | High authority, borrower-centric |
| Borrower address | Bank statement account holder address block | 2.0 | Strong but sometimes mailing/PO box |
| Borrower address | Paystub employee info block | 2.0 | Usually borrower address if present |
| Borrower address | Paystub header / employer block | 0.25 | Common source of confusion |
| Borrower address | W-2 employer address block | 0.0–0.25 | Not borrower; weight near-zero unless explicitly labeled otherwise |
| Income amount | W-2 wages boxes (annual) | 3.0 | Strong for wages for that year |
| Income amount | 1040 / Schedule C net profit | 3.0 | Strong for self-employment for that year |
| Income amount | Paystub YTD / rate-of-pay (with period) | 2.0 | Useful but can be partial/periodic |
| Income amount | Verifications (EVOE) | 2.0 | Generally good but can be derived/annualized |
| Income amount | Free-text letters of explanation | 0.5–1.0 | Self-reported; keep but low authority |

### 4.5 Edge cases

- **Single element in domain**: If there is only one element in the conflict domain, `unfavorable_weight = 0`; score will be very large → treat as HIGH (subject to minimum-evidence rules if you add them).
- **Missing context hints**: If you cannot tell “employer block” vs “employee block,” use only doc-type baseline weights (and keep them conservative).
- **Many low-weight duplicates**: Weighted scoring prevents many repeated low-weight evidences from dominating fewer high-weight evidences.

---

## 5. Order of operations (logical)

1. **Extract** from payload: for each borrower, full name, identifiers, addresses, income_history, application refs.
2. **Candidates**: Query existing borrowers where normalized full name matches.
3. **Match**: For each candidate (same normalized name), check for strong conflicting evidence (SSN with proximity_score 3 that does not overlap existing; or conflicting address with proximity_score ≥ 2). If no strong conflict → merge into that borrower; else create new borrower.
4. **Resolve borrower**: If at least one candidate has no strong conflict → use that borrower's id for merge; else create new borrower and use new id.
5. **Merge entities**: For each address (resp. identifier, income) in payload, determine "same" existing element or create new; add evidence and retain most complete value where defined.
6. **Confidence**: For each merged element (address, identifier, income), set n_favorable = evidence count on this element, n_unfavorable = sum of evidence counts on all other elements of same type; compute score and assign HIGH / MEDIUM / LOW.
7. **Persist**: Save borrower and all merged elements with their evidences and confidence (storage format is out of scope here).

---

## 6. Summary of logical rules

| Area | Rule |
|------|------|
| **Candidates** | Same normalized full name. |
| **Partial match** | Identifier value match; SSN overlap (visible digits); zip match; address meaningful portion (city+state or street+city+state or zip+state). |
| **Match decision** | Merge by default (same name → same borrower); create new borrower only when strong conflicting evidence (SSN with proximity 3 that does not overlap, or conflicting address with proximity ≥ 2). See §2.3. |
| **Address merge** | Same address → add evidence to existing; else new address. |
| **Identifier merge** | Same type + overlap (e.g., SSN overlap) → add evidence, keep most complete value; else new identifier. |
| **Income merge** | Same `income_identity_key` (mandatory `source_type` + employer_norm + period_key) → add evidence to existing; else new income. |
| **Confidence** | Weighted evidence scoring within each conflict domain: favorable_weight vs unfavorable_weight; score = favorable_weight / max(unfavorable_weight, ε); HIGH if score > 1, MEDIUM ~ 1, LOW < 1. |
