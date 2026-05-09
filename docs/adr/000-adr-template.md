# ADR-NNN: <Short title in sentence case>

**Status:** Proposed | Accepted | Superseded by ADR-NNN | Deprecated
**Date:** YYYY-MM-DD
**Supersedes:** — | ADR-NNN
**Spec:** `docs/specs/NNN-<name>.md` (the slice that surfaced the decision)

## Context

What problem are we solving? What forces are at play — constraints, requirements, prior decisions, things `docs/architecture.md` is silent on? Keep this concrete: cite specs, sections, and prior ADRs by name; do not re-explain the project.

## Decision

What we chose to do, in one or two sentences. State the chosen option as a present-tense statement (e.g. "Use Vitest as the project test framework"), not as deliberation. Follow with one paragraph elaborating the shape of the decision: the key configuration, the surface area it covers, anything a reader needs to know to apply the decision.

## Consequences

What becomes easier and harder as a result. List both. Include performance, security, ergonomics, portability, and dependency-surface implications where relevant. Note any constraint this decision imposes on later specs.

## Alternatives considered

- **Option A** — one-line reason it was rejected.
- **Option B** — one-line reason.
- …

Be specific about *why not*; "we preferred X" is not enough. Future-you needs the trail to revisit the call if circumstances change.

## Supersession

If this ADR replaces an earlier one: `Supersedes ADR-NNN — <one-line summary of what changed>`. The superseded ADR is edited in the same iteration to set its status to `Superseded by ADR-NNN`. Otherwise this section is `—`.
