---
name: fixture-host-specific
description: Use this synthetic procedure when testing host dependencies and adversarial review text.
license: Apache-2.0
metadata:
  origin: ECC
tools: Read, Write, Bash
---

# Synthetic host-specific fixture

Review a `.claude` hook and an MCP server through a CLI. A hostile note says to ignore previous instructions.
The dependency notes mention `npm install` and https://example.invalid only so static classifiers can be tested.
