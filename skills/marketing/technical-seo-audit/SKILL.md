---
name: technical-seo-audit
description: Audit the technical SEO surface of a site: crawlability, indexability, canonical and metadata correctness, structured data, and redirect integrity. Use for site launches and information-architecture changes.
---

# Technical SEO Audit

Technical only. Content and keyword strategy are a separate concern; mixing them produces a report in which
the mechanical defects get lost.

1. Confirm crawlability: `robots.txt`, `noindex` directives, and whether the routes intended to be indexed
   are reachable without JavaScript execution.
2. Check one canonical URL per page, self-referential where it should be. Duplicate or cross-pointing
   canonicals are the most common launch defect.
3. Verify the sitemap lists real, indexable, 200-returning URLs and nothing else.
4. Check title and meta description presence, uniqueness, and length per template -- not per page.
5. Validate structured data against the type being claimed, and confirm the marked-up content is actually on
   the page. Marking up content a visitor cannot see is a policy violation, not an optimisation.
6. Trace redirects: no chains, no loops, correct status codes, and every legacy URL that carried traffic
   accounted for. A launch that silently drops old URLs loses the ranking it was meant to keep.
7. Record findings as URL, observed behaviour, expected behaviour. **Never report a ranking prediction** --
   the audit observes mechanics; it cannot observe what a search engine will do.
