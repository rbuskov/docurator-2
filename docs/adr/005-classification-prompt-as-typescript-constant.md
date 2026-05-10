# ADR-005: Classification prompt as a TypeScript constant

**Status:** Accepted
**Date:** 2026-05-09
**Supersedes:** —
**Spec:** `docs/specs/005-classify-one-email-end-to-end.md`

## Context

Slice 005 is the first slice that calls a vision model (`qwen2.5vl:7b` via Ollama) and needs a classification prompt. The prompt has two pieces: a long-lived **system message** that describes the task, the strict JSON output schema, and the conservative-confidence rule; and a per-call **user message** that packs the email's metadata, body, and image references. The system message is the durable artifact — it changes when the maintainer wants different model behavior; otherwise it sits unchanged across thousands of classifications.

`docs/architecture.md` § "Components — Classification module" describes the prompt's content (metadata + body + images, conservative confidence) but does not say where the prompt copy *lives* in the codebase. Slice 005's spec § "Files / modules" pins it to `src/server/classify/prompt.ts` and notes "the system-prompt copy lives here as a TypeScript constant; tuning it later is a one-file change." The spec § "Implementation notes" expands: "Tuning the prompt is a code change. For a self-hosted single-user tool that's the right tradeoff."

This ADR records the rejected alternatives and the constraint the choice imposes on later slices. The decision is small but durable: every prompt-related slice (Slice 014's reclassification, Slice 015's sender-memory hints, any future model-swap work) inherits the same lookup pattern.

## Decision

Keep the classification system prompt as a **`const SYSTEM_PROMPT = '...'` template-literal string** at the top of `src/server/classify/prompt.ts`. The exported `buildClassificationMessages(input)` function inlines it into the system message verbatim per call. There is no I/O, no DB row, no env var override, no per-account tuning surface. Tuning the prompt is a code edit + tests + commit + redeploy.

The prompt is co-located with the user-message construction (subject/from/date/body/images formatting) so a contributor reading either piece sees both — they're conceptually one artifact (what the model sees) split across two messages by Ollama's wire format.

## Consequences

- **Tuning friction is high in absolute terms but right for v1's user.** Editing the prompt requires a `git pull && npm test && docker compose up -d`. For a self-hosted single-user tool this is acceptable — the user *is* the maintainer; the loop "edit → run → see model output" is a code-change loop already.
- **Prompt copy is version-controlled.** Every prompt revision is a `git diff` against the prior one. Performance regressions in the model's classification quality can be `git bisect`-ed against prompt edits the same way any other behavior change is.
- **Tests can pin invariants.** `prompt.test.ts` asserts that the system message contains the JSON-schema field names, the `'confidence': 'low'` instruction, and the "ONLY the JSON object" rule. A prompt edit that drops one of those fails the test, which is the desired forcing function.
- **No runtime mutation surface.** A compromised admin user / a misconfigured deployment cannot inject prompt prefixes (e.g. "ignore previous instructions and return X"). The prompt's bytes are part of the build.
- **Constraint imposed on later specs.** Slice 014's reclassification picks a different model but reuses this prompt. Slice 015's sender-memory hints would extend the *user* message with "the user has previously approved N receipts from this domain", not modify the system message. A future spec that genuinely needs per-account prompt tuning (e.g. user-language localization, accounting-vertical-specific rules) supersedes this ADR; until then, one prompt for one install.
- **No CI-time eval harness yet.** A prompt change today is verified by re-running the smoke flow against real receipts. A future "prompt regression" suite (a corpus of (email, expected-verdict) fixtures) would let prompt edits be evaluated without manual smoke-testing. Out of scope for Slice 005; flagged as a Slice 016+ idea.
- **Multi-line string ergonomics.** Backtick template literals carry whitespace verbatim, which means indentation in the source file becomes indentation in the prompt. The constant lives at module top-level (column 0) so the literal's content has no leading spaces. A future contributor who reformats the file via `prettier` (the project's default formatter) might re-indent the literal; the test suite's contains-substring assertions would not catch that. Acceptable risk; the edit pattern is "select all between backticks, replace" not "format on save."

## Alternatives considered

- **External `.txt` / `.md` file loaded at startup.** Adds a startup-time `readFileSync`, requires the file to be copied into `dist/server/` during the build (the runtime resolves a path relative to `import.meta.url`), and makes prompt edits a non-code change that escapes the typecheck and the test runner unless additional tooling reads the file. The substring-test invariants would still need to be encoded somewhere; the simplest place is alongside the prompt, which negates the separation.
- **DB row in `app_config`.** Lets the user edit the prompt at runtime via a future settings UI. Premature: there is no settings UI in v1, no audit trail for prompt edits, no concurrency control if two browser tabs edit at once. The DB-as-prompt-store also turns prompt history into "whatever happens to be in `app_config` right now" — a worse property than `git log`.
- **Env var (`OLLAMA_SYSTEM_PROMPT`).** Multi-line copy is awkward in a `.env` file (need to escape newlines or use a single-line condensed prompt). Production deployments would need to keep the env var in lockstep with code expectations. The configuration surface for env vars is for *operational* values (URLs, ports, timeouts), not large content blobs.
- **Per-account / per-tag prompt customization.** The architecture is single-user, single-install. Per-account customization would need a UI surface, a DB column, a precedence rule when an account is missing a custom prompt — none of which has a v1 use case. Defer until a real per-account request emerges.
- **Generate the prompt from the Zod schema (`zod-to-json-schema` etc.).** Removes the manual sync between `schema.ts` and `prompt.ts`. Adds a runtime dependency, makes the prompt's wording dependent on the schema generator's output (which a contributor may want to override for clarity), and obscures the actual bytes the model receives. The two files are 30 lines apart in the same directory; a manual cross-reference is cheaper than the abstraction.
- **Separate "prompts" repo / package.** Overkill for a single prompt in a single-user tool. Mentioned only because some teams structure prompt management this way for multi-product orgs; not relevant here.

## Supersession

—
