---
name: contract-intake-extraction
description: Extract parties, dates, amounts, obligations and governing law from an agreement into a structured record with a source span for every field. Use when turning contract documents into searchable metadata a human will rely on.
---

# Contract Intake and Extraction

A mis-extracted term becomes the record used for renewal notices and dispute positions. Report absence; never fill a gap.

1. List every source document by path and note its format. Do not extract from a file you did not read.
2. For each field in the agreed schema (parties, effective date, term, renewal, notice period, value,
   payment terms, governing law, termination rights), record the value **and the exact quoted span plus its
   location** in the source. A value without a span is not an extraction; it is a guess.
3. Where a field is not present, write `not found`. **Never infer a value from a similar contract, a file
   name, or a party's usual terms.**
4. Flag every date and amount that appears more than once with different values. Renewal, effective and
   execution dates are the fields most often bound to the wrong number.
5. Name each party exactly as written, including entity suffix. If a subsidiary and a parent both appear,
   record both and mark which one signs -- do not collapse them.
6. Produce a confidence marker per field: `quoted` (span copied verbatim), `derived` (computed from quoted
   spans, showing the arithmetic), or `not found`. No fourth category.
7. **Stop at the boundary.** The extraction is an index, not advice. A person with authority reads the
   flagged fields before anything is filed, renewed, or relied on. State that in the output.
