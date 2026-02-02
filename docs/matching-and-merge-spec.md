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

### 2.3 Match decision

- **Rule (match decision)**:
  - If there are no candidates (no existing borrower with same normalized name), **create a new borrower**.
  - Else, for each candidate, compute a **match score** from partial-match signals (e.g., count of signals that hold, or weighted sum).
  - If the **best candidate** has match score above a chosen **threshold** (e.g., at least one strong signal such as SSN overlap or identifier match, or at least two medium signals such as zip + address partial match), treat the payload borrower as the **same** as that candidate; use that candidate’s borrower record for merge.
  - Otherwise, **create a new borrower**.

- **Strong vs medium**: Strong = SSN overlap, identifier value match. Medium = zip match, address meaningful-portion match. Threshold can be "at least one strong" or "at least two medium" or a numeric score; exact threshold is an implementation choice.

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

- **Same income**: Two income entries are the **same** if they refer to the same employer and same period (e.g., same year), and optionally same source_type (e.g., w2). Exact rule (e.g., employer + period_year) is implementation-defined.
- **Rule (income merge)**:
  - For each income in the payload, check whether there exists an existing income for this borrower that is "same" (employer + period, and any other defined keys).
  - If **same**: do not create a new income; **add the incoming evidence** to that existing income. Optionally update amount/frequency if the incoming value is more authoritative (e.g., from a primary doc).
  - If **no same**: add a **new** income with the incoming value and its evidence.

---

## 4. Confidence scoring

After merge, each **element** (each address, each identifier, each income record) is assigned a **confidence level** so that consumers can prioritize (e.g., show HIGH first, or use only HIGH for critical decisions).

### 4.1 Definitions (per element, per type)

- **Element**: One logical address, or one logical identifier (e.g., one SSN), or one logical income record, for a given borrower.
- **Same type**: For identifiers, "same type" means all identifiers of that kind (e.g., all SSNs for this borrower). For addresses, "same type" means all addresses for this borrower. For income, "same type" means all income entries for this borrower.

- **n_favorable** (for this element):  
  Number of **evidences** attached to **this** element (after merge).

- **n_unfavorable** (for this element):  
  Number of **evidences** attached to **all other** elements of the **same type** for this borrower.  
  So: evidence that supports a *different* value of the same type (e.g., a different SSN, a different address) counts as unfavorable for this element.

### 4.2 Interpretation

- **Favorable**: Evidence supporting *this* value.
- **Unfavorable**: Evidence supporting a *competing* value of the same type. So the more evidence there is for other SSNs (or other addresses, or other income entries), the higher n_unfavorable for this element, and the lower its confidence.

### 4.3 Score and confidence level

- **Score** (for this element):  
  `score = n_favorable / n_unfavorable`  
  If `n_unfavorable == 0`, treat as "no competing evidence"; e.g. `score = n_favorable` or use a cap so that confidence is HIGH when there is no competing evidence. Implementation may use `score = n_favorable / max(n_unfavorable, 1)` to avoid division by zero.

- **Confidence level**:
  - **HIGH**:   `score > 1`
  - **MEDIUM**: `score == 1`
  - **LOW**:    `score < 1`

- **Rationale**: An element with more supporting evidence than competing evidence (score > 1) is HIGH; equal evidence (score == 1) is MEDIUM; less supporting than competing (score < 1) is LOW. No need to label evidence as "from EVOE" or "from W2"—the split between "this element’s evidence" vs "other elements’ evidence" carries the signal.

### 4.4 Edge cases

- **Single element of its type**: e.g., borrower has only one SSN. Then n_unfavorable = 0; treat score as HIGH (or use `n_favorable / 1` so score = n_favorable, and define HIGH as score >= 1 if desired).
- **Many elements, one with most evidence**: The element with the most evidences gets the highest score (largest n_favorable, smallest n_unfavorable sum from others); others get lower scores and may be LOW.

---

## 5. Order of operations (logical)

1. **Extract** from payload: for each borrower, full name, identifiers, addresses, income_history, application refs.
2. **Candidates**: Query existing borrowers where normalized full name matches.
3. **Match**: For each candidate, evaluate partial-match signals (identifier, SSN overlap, zip, address). Compute match score; select best candidate and compare to threshold.
4. **Resolve borrower**: If match above threshold → use that borrower’s id for merge; else create new borrower and use new id.
5. **Merge entities**: For each address (resp. identifier, income) in payload, determine "same" existing element or create new; add evidence and retain most complete value where defined.
6. **Confidence**: For each merged element (address, identifier, income), set n_favorable = evidence count on this element, n_unfavorable = sum of evidence counts on all other elements of same type; compute score and assign HIGH / MEDIUM / LOW.
7. **Persist**: Save borrower and all merged elements with their evidences and confidence (storage format is out of scope here).

---

## 6. Summary of logical rules

| Area | Rule |
|------|------|
| **Candidates** | Same normalized full name. |
| **Partial match** | Identifier value match; SSN overlap (visible digits); zip match; address meaningful portion (city+state or street+city+state or zip+state). |
| **Match decision** | Best candidate above threshold (e.g., ≥1 strong or ≥2 medium) → same borrower; else new borrower. |
| **Address merge** | Same address → add evidence to existing; else new address. |
| **Identifier merge** | Same type + overlap (e.g., SSN overlap) → add evidence, keep most complete value; else new identifier. |
| **Income merge** | Same employer + period → add evidence to existing; else new income. |
| **Confidence** | n_favorable = evidences on this element; n_unfavorable = evidences on all other elements of same type; score = n_favorable / max(n_unfavorable, 1); HIGH if score > 1, MEDIUM if score = 1, LOW if score < 1. |
