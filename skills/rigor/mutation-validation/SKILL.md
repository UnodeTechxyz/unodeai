---
name: mutation-validation
description: Use during a change when a test must prove it detects a named product failure.
---

# Mutation validation

Use this only on a disposable working-tree mutation. It proves that a test is load-bearing; it is not a
reason to alter product behaviour or weaken an assertion.

1. Name the product decision or invariant the test is meant to protect.
2. Make the smallest reversible mutation to that product code that violates the invariant. Do not mutate
   only the test, fixture, or mock unless that layer is the claimed product boundary.
3. Run the focused test and record the specific expected failure. If it passes, stop: the test does not
   prove the claimed behaviour.
4. Revert exactly the mutation, inspect the diff, and rerun the focused test green.
5. In release evidence, record the mutation, failing test, observed failure, restoration, and green rerun.

Never leave the mutation in a commit. A full suite is useful after restoration, but it cannot replace the
focused red-then-green proof.
