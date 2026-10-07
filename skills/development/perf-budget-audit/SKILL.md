---
name: perf-budget-audit
description: Measure bundle size, load time, and runtime metrics against a performance budget. Use when you need a repeatable perf-budget-audit procedure while planning, building, or reviewing work.
---

# Performance Budget Audit

Audit the project against a performance budget:
1. Define or read the budget: max first-party JS bundle size, first contentful paint (FCP), largest contentful paint (LCP), and total blocking time (TBT).
2. Run production build and capture bundle sizes per route/chunk. Flag any chunk exceeding its budget.
3. Measure load metrics with a tool like Lighthouse or WebPageTest. Record FCP, LCP, TBT, and CLS.
4. Identify the largest contributors: oversized images, unminified code, duplicate dependencies, or excessive third-party scripts.
5. Recommend concrete fixes: code splitting, lazy loading, image optimization, tree shaking, or dependency replacement.

Output: a budget report with current vs. target values, the largest offenders, and a prioritized fix list.
