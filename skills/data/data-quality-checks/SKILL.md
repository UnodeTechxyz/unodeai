---
name: data-quality-checks
description: Define versioned, repeatable data-quality checks for a dataset or pipeline stage. Use when you need a repeatable data-quality-checks procedure while planning, building, or reviewing work.
---

# Data Quality Checks

Based on dbt and Great Expectations patterns:
1. Identify the dataset, schema, and columns that changed or are consumed.
2. Verify row count, freshness, and schema drift against the declared contract.
3. Check for nulls, duplicates, and out-of-range values in key columns.
4. Validate referential integrity across foreign-key relationships.
5. Confirm distributions and categorical values match historical baselines.

Return: data-quality report with failed checks, affected columns, and remediation steps.
