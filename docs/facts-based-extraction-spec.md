# Facts-Based Extraction Spec (Proposed)

This document describes a **proposed** extraction and attribution model. The LLM emits **facts** (not borrower-centric records); each fact includes the value, evidence, and **all names found in proximity** with a **proximity score**. A deterministic **attribution layer** then assigns facts to borrowers or applications. This approach aims to reduce LLM attribution errors (e.g., employer address as borrower address) and to support extensibility (e.g., loan number, other linking facts).

**Status:** Proposal for future implementation. Use this doc to refine the design, update existing specs, and create an implementation plan. The current extraction contract (borrower-centric) and matching/merge logic in `matching-and-merge-spec.md` remain in effect until this approach is adopted.

---

## 1. Motivation

### 1.1 Problems with borrower-centric extraction

- **Attribution errors**: The LLM must decide "this address belongs to borrower X" vs "this is the employer's address." Misattribution (e.g., employer address → borrower) is common and leads to wrong data and duplicate records when corrected.
- **Single shot per field**: The model commits to one borrower per field; proximity and context are implicit and hard to correct downstream.
- **Limited extensibility**: Top-level structures (borrowers, applications) make it awkward to add document-level or linking facts (e.g., loan number in a header) in a uniform way.

### 1.2 Goals of facts-based extraction

- **Observable over inferred**: The LLM reports **what is on the page and where** (facts + names nearby + distance). **Who** the fact belongs to is decided deterministically by an attribution layer using proximity scores, evidence context, and existing matching/merge rules.
- **More deterministic**: Proximity (e.g., "name is 1 line above the address") is easier for the model to report than "this address is the borrower's."
- **Extensibility**: A single **fact** shape can represent PII (address, SSN, income) and non-PII linking facts (loan number, document type). Attribution rules decide whether a fact attaches to a borrower or an application.

---

## 2. Fact schema (LLM output)

The extraction payload is an array of **facts**. Each fact has:

| Field | Type | Description |
|-------|------|-------------|
| **fact_type** | string (enum) | Kind of fact: e.g. `address`, `ssn`, `income`, `loan_number`, `employer_name`, … |
| **value** | type-specific | The extracted value (e.g., address fields, SSN string, income amount + period, loan number string). |
| **evidence** | object[] | Provenance: document_id, source_filename, page_number, quote. Optional: block/context label for weighting (e.g., employer_block, employee_block). |
| **names_in_proximity** | object[] | All full names the model observed near this fact, each with evidence and a proximity score. |

### 2.1 names_in_proximity (per name)

| Field | Type | Description |
|-------|------|-------------|
| **full_name** | string | The name as it appears (e.g., "John Homeowner"). |
| **evidence** | object[] | Where this name appears (document_id, page_number, quote). |
| **proximity_score** | number | How close this name is to the fact. Higher = closer. See §3. |

Names beyond a chosen distance (e.g., more than 2–3 lines from the fact) should receive a low or zero score so they do not win attribution.

### 2.2 Fact types and value shapes (starter set)

| fact_type | value shape | Attribution target |
|-----------|-------------|--------------------|
| `address` | street1, street2, city, state, zip | Borrower (or application for property) |
| `ssn` | string (e.g. xxx-xx-5000 or full) | Borrower |
| `income` | amount, currency, frequency, period, employer?, source_type? | Borrower |
| `loan_number` | string | Application |
| `employer_name` | string | Borrower (for income context) or metadata |

Additional fact types (e.g., account_number, phone) can be added with the same pattern.

### 2.3 Evidence and optional context

Evidence continues to support **evidence_source_context** (or block label) for weighting, as in the current matching-and-merge spec §4.4. For example:

- Address in "employer block" → low weight for borrower address.
- Address in "employee block" → high weight for borrower address.

Proximity score and context can be combined in the attribution layer (e.g., prefer name with highest proximity_score; tie-break with evidence weight).

---

## 3. Proximity scoring

Proximity is defined relative to the **fact** (the value being attributed). The model reports how close each candidate name is to that fact.

### 3.1 Score scale (suggested)

| Score | Meaning | Use in attribution |
|-------|---------|--------------------|
| **3** | Same line as the fact (or same logical block) | Strong candidate. |
| **2** | Within 1 line (above or below) | Strong candidate. |
| **1** | Within 2–3 lines | Weaker candidate. |
| **0** | Farther than 2–3 lines, or irrelevant | Do not use for attribution (or use only as last resort). |

Implementations may use a different scale (e.g., 0–1 float) as long as "closer = higher" is consistent.

**Persistence and read API:** The chosen name's **proximity_score** for each fact is persisted per evidence row (address, identifier, income) and returned in the read API (`/borrowers`, application record) so that consumers and the matching layer can use it. The matching-and-merge spec uses this score for the "split only on strong conflict" rule (see `docs/matching-and-merge-spec.md` §2.3).

### 3.2 Definition of "line"

- **Plain-text extraction**: Line = line of text (newline-separated). "Within N lines" = within N newline-delimited lines of the fact’s quote or anchor position.
- **PDF / vision**: The model infers logical lines or blocks from layout. The prompt should define "line" or "block" so that proximity_score is consistent (e.g., "same line = same visual line or same table row").

Specifying "2–3 lines" in the prompt as the cutoff for low/zero score keeps the rule simple and implementable.

---

## 4. Attribution layer (deterministic)

After extraction, a separate **attribution** step assigns each fact to a **borrower** or an **application**.

### 4.1 Inputs

- Array of facts (each with value, evidence, names_in_proximity with proximity_score).
- Optional: existing borrowers and applications (for matching and merge).

### 4.2 Rules (high level)

1. **Resolve names to borrowers**: For each distinct full name in any `names_in_proximity`, resolve to an existing borrower (using name normalization and the matching rules in `matching-and-merge-spec.md` §2) or create a new borrower.
2. **Choose best name per fact**: For each fact, among the names in `names_in_proximity`, pick the name with the **highest proximity_score**. If tied, use evidence_source_context/weight (e.g., prefer name in employee block over employer block). The chosen name determines the **candidate borrower** (or, for loan_number, the fact may be application-scoped).
3. **Assign fact to entity**:
   - For borrower-scoped fact types (address, ssn, income, …): Attach the fact to the borrower resolved from the chosen name (highest proximity_score; tie-break by context).
   - For `loan_number`: Create or find application by loan number; link **all** borrowers resolved from names_in_proximity to that application as parties (even when all proximity scores are 0, since the loan number applies to all applicants on the document).
4. **Merge and confidence**: Once facts are assigned to borrowers/applications, apply the existing **merge** and **confidence** rules from `matching-and-merge-spec.md` (§3 and §4). No change to merge semantics (same address → add evidence; same identifier → add evidence; etc.) or to confidence scoring (weighted evidence, conflict domains).

### 4.3 Edge cases

- **No names in proximity (empty)**: If `names_in_proximity` is empty, the fact may be dropped or assigned to a default/unknown bucket per policy.
- **All proximity scores are 0**: Do not treat this the same as "no names." For **document-level facts** such as `loan_number`, applicant names are often far from the fact (e.g., loan number in a header, names in the body). All listed names are still valid for linking: create or find the application by loan number and link **all** names in `names_in_proximity` as parties, regardless of score. For **borrower-scoped facts** (address, ssn, income), when all scores are 0 the policy may differ (e.g., drop the fact, or assign to a single borrower using other signals).
- **Multiple names with same score**: Use evidence_source_context/weight to break ties; if still tied, implementation may choose the first or apply a deterministic rule.
- **Loan number in header**: `fact_type: loan_number` with value and names_in_proximity (e.g., borrowers on the loan) allows the attribution layer to create an application and link those borrowers as parties—even when all proximity scores are 0, since the names and loan number belong to the same application.

---

## 5. Extensibility: non-PII facts

Using **facts** (rather than only "PII") allows document-level or linking data to use the same pipeline:

- **Loan number**: Emitted as a fact with value and names_in_proximity. Attribution creates or finds the application and links **all** names as parties (proximity may be low/zero when the loan number is in a header; all names on the document still belong to that application).
- **Document type or source**: Could be a fact or metadata; used for weighting or filtering.
- **Future fact types**: New types (e.g., phone, email, account_number) follow the same schema; attribution rules and value shape are defined per fact_type.

---

## 6. Relationship to existing specs

| Current artifact | Relationship |
|------------------|--------------|
| **Extraction result schema** | Replaced or versioned: payload becomes `facts[]` instead of `borrowers[]` + `applications[]` in the current shape. A new schema version (e.g. 2.0) can define the fact-centric contract. |
| **Matching (§2)** | Unchanged in logic: attribution produces "fact → borrower_id (or application_id)"; resolving the chosen name to borrower_id still uses normalized name + partial match signals (SSN overlap, zip, address). |
| **Merge (§3)** | Unchanged: once facts are converted to (borrower_id, address), (borrower_id, identifier), etc., merge and deduplication rules apply as today. |
| **Confidence (§4)** | Unchanged: confidence is computed per merged element from evidence weights (and optionally proximity); conflict domains and scoring formula stay the same. |
| **Evidence weights / evidence_source_context** | Kept: facts can carry evidence_source_context (or block label) for weighting; attribution can use it in tie-breaking. |

---

## 7. Implementation outline (for a future plan)

1. **Schema and LLM**: Define the fact schema (fact_type, value, evidence, names_in_proximity with proximity_score). Update or add LLM prompts (text + PDF fallback) to emit facts in this shape. Optionally keep evidence_source_context on evidence for weighting.
2. **Attribution service or step**: Implement the attribution layer (name resolution → borrower_id/application_id; choose best name per fact by proximity_score and context). Output: list of (fact, borrower_id) or (fact, application_id) for borrower- and application-scoped facts.
3. **Persistence**: Consume attributed facts and feed them into the existing persistence/merge logic (so that merge and confidence remain as in the current spec). Persistence may need to accept "attributed fact" input instead of "borrower-centric extraction" or a thin adapter may convert attributed facts into the current borrower/application shape before persistence.
4. **Testing and rollout**: Golden outputs for fact-based extraction; integration tests for attribution + persistence. Roll out behind a flag or as a new pipeline path, then migrate.

---

## 8. Summary

| Concept | Description |
|---------|-------------|
| **Fact** | One extracted value (address, SSN, income, loan number, …) with evidence and names_in_proximity. |
| **names_in_proximity** | All names observed near the fact, each with evidence and proximity_score (higher = closer). |
| **Proximity score** | 0–3 (or similar): same line = 3, within 1 line = 2, within 2–3 lines = 1, farther = 0. |
| **Attribution** | Deterministic step: resolve names to borrowers; for each fact, pick best name by score (and context); assign fact to that borrower or to application (for loan_number). |
| **Merge & confidence** | Existing rules in `matching-and-merge-spec.md` apply to the attributed facts; no change to merge or confidence logic. |

This document is the reference for refining the design, updating `matching-and-merge-spec.md` and related docs, and creating a detailed implementation plan.

---

## 9. Two-Step Document Classification and Extraction

### 9.1 Overview

The extraction pipeline uses a two-step approach to improve accuracy:

1. **Classification** (fast model, ~100-200ms): Identifies document type
2. **Extraction** (standard model): Uses document-specific template with precise rules

This approach solves:
- **Proximity scoring failures**: Templates encode document semantics (e.g., "all W-2 facts belong to the employee")
- **Lost document structure**: Templates know which sections matter for each document type
- **Generic prompt limitations**: Document-specific rules prevent common errors (e.g., extracting employer address as borrower address)

### 9.2 Classification Step

The classification model (`gpt-5-nano` by default) receives a preview of the document text (~2000 characters) and returns:

```json
{
  "document_type": "paystub",
  "confidence": 0.95,
  "reasoning": "Document shows pay period, gross pay, deductions, and employer header - typical paystub format"
}
```

**Supported document types:**
- `w2`: IRS Form W-2 (Wage and Tax Statement)
- `paystub`: Pay stub / earnings statement
- `bank_statement`: Bank account statement
- `closing_disclosure`: Loan closing disclosure
- `tax_return_1040`: IRS Form 1040 tax return
- `evoe`: Employment Verification
- `unknown`: Fallback for unrecognized documents

**Confidence threshold:** If classification confidence falls below the threshold (default 0.7), the system uses the `unknown` template.

### 9.3 Document-Specific Templates

Each template encodes document semantics:

#### W-2 Template Rules
- ALL facts belong to the EMPLOYEE (the person receiving the W-2)
- Extract employee address from Box f ONLY (not employer address from Box c)
- Extract employer_name from Box c for income context
- Extract wages from Box 1 with frequency: "annual"
- All names_in_proximity entries get proximity_score: 3

#### Paystub Template Rules
- Two distinct sections: EMPLOYER (header) and EMPLOYEE (body)
- Extract employee address from employee section only (proximity_score: 3)
- Employer address gets employee with proximity_score: 0
- DO NOT extract employer address as borrower address

#### Bank Statement Template Rules
- May have MULTIPLE account holders (joint accounts)
- ALL account holders share the mailing address (all get proximity_score: 3)
- Extract account number as identifier
- Do NOT extract bank address

#### Closing Disclosure Template Rules
- Extract PROPERTY address (the loan collateral), not borrower mailing address
- ALL borrowers share the property (all get proximity_score: 3)
- Extract loan_number as identifier
- Do NOT include seller names in borrower facts

### 9.4 Extraction Metadata

The extraction result includes classification metadata:

```json
{
  "extraction_metadata": {
    "provider": "openai",
    "model": "gpt-5-mini",
    "request_id": "req_abc123",
    "prompt_version": "4.0.0-two-step",
    "document_type": "paystub",
    "classification_model": "gpt-5-nano",
    "classification_confidence": 0.95
  }
}
```

### 9.5 Configuration

Environment variables:
- `LLM_MODEL_CLASSIFICATION`: Model for classification (default: `gpt-5-nano`)
- `CLASSIFICATION_CONFIDENCE_THRESHOLD`: Minimum confidence to use specialized template (default: `0.7`)

### 9.6 Templates Location

Templates are defined in `packages/shared/src/templates/`:
- `types.ts`: ExtractionTemplate interface, ClassificationResult interface
- `classification.ts`: Classification prompt and schema
- `w2.template.ts`, `paystub.template.ts`, etc.: Document-specific templates
- `unknown.template.ts`: Fallback generic template
- `index.ts`: `getTemplateForDocumentType()` function
