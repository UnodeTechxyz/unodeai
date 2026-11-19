---
name: test-coverage-gap
description: Find untested code paths, missing edge cases, and low-coverage modules. Use when you need a repeatable test-coverage-gap procedure while planning, building, or reviewing work.
---

# Test Coverage Gap Analysis

1. Find how the project measures coverage: its test scripts (for example package.json, Makefile, pyproject.toml,
   build files) or CI configuration. Run that command, for example `npm test -- --coverage`, `pytest --cov`,
   `go test -cover ./...`, `cargo llvm-cov`, or the JaCoCo report of a Maven or Gradle build. If coverage is not
   set up, say so and work from reading the code and the tests.
2. Use the project's own coverage threshold. If it has none, do not invent a pass mark; rank by risk instead.
3. For each low-coverage area, find the largest uncovered function or branch and weigh it by risk: error
   handling, security checks, data writes, and recently changed code come first.
4. Look for paths a coverage number misses: error branches, boundary values, concurrency, and `TODO` or `FIXME`
   notes.
5. For an API, check that each documented status code or error has at least one test.

Output: how you measured coverage, then a ranked gap list (file, uncovered lines or branches, risk) with a
one-sentence test suggestion per gap.
