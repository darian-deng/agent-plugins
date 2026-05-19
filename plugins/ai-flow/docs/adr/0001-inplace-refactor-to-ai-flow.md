# ADR 0001: In-place refactor of feat-flow → ai-flow engine

## Status
Accepted

## Context
The feat-flow plugin needs a fundamental redesign: from a hardcoded 8-stage feature workflow to a generic, config-driven AI workflow engine (ai-flow) that supports multiple user-defined flow types.

Two options were considered:
1. Create a new `plugins/ai-flow/` package from scratch
2. Refactor `plugins/feat-flow/` in place

## Decision
Refactor in place within `plugins/feat-flow/`.

## Reasons
- All existing test infrastructure (`createTestRepo`, git fixtures, `vitest` setup) lives here; copying it to a new package adds friction with zero benefit
- The marketplace entry `feat-flow@darian-agent-plugins` is the existing installed plugin; in-place refactor avoids forcing a reinstall
- All git history, CI config, and package lock remain intact
- The package is renamed to `ai-flow@darian-agent-plugins` as a final step after the refactor stabilises, not as a prerequisite

## Trade-offs
- Existing tests will break progressively as the refactor proceeds; they are updated alongside each component rather than kept green throughout
- The directory name `plugins/feat-flow/` does not match the final package name until the rename step
