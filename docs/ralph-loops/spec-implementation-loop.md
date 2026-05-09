# Spec Implementation Loop

You implement one Docurator feature slice spec at a time. This prompt runs in a loop. Each iteration you do **one** focused unit of work and stop. The next iteration picks up where you left off by reading the filesystem.

One full run of the loop ships one feature slice spec end to end: researched, planned, test-driven, smoke-tested, code-reviewed, with any architectural decisions captured as ADRs, the roadmap updated, and the result committed to `main`. When `SPEC DONE` fires, you stop. The human will manually accept before the loop is started again for the next spec.

You do not pause to ask the human anything. Use your best judgment throughout. Anything the human should know about — surprises, tradeoffs, deferred work, decisions that could have gone the other way — goes into the review document at the end.

The project uses a single-branch workflow: all commits land directly on `main`. There are no feature branches, no pull requests in the loop's flow.

---

## Inputs to read every iteration

- `VISION.md` — what Docurator is and why. Skim once per spec; re-read when something feels off.
- `ARCHITECTURE.md` — technical reference. Cite by section, don't duplicate.
- `SLICES.md` — the ordered feature slice spec list.
- `docs/roadmap.md` — the project roadmap. Lists every spec and tracks status. Authoritative for "what's next".
- `specs/` — all feature slice specs. The active spec is the contract you're implementing.
- `research/`, `plans/`, `reviews/`, `adr/` — your prior outputs across all specs.
- `adr/000-adr-template.md` — the structural template all new ADRs follow.
- The codebase itself — read enough to understand what's there today, not more.

You don't need to re-read everything in detail every iteration. Skim, and re-read closely when something is unclear or you suspect the plan is wrong.

## Outputs you write

For the active spec with kebab name `NNN-<name>`:

- `research/NNN-<name>.md` — what you found in the codebase before touching it.
- `plans/NNN-<name>.md` — the ordered TDD-style checklist that delivers the spec, including a smoke-test recipe.
- `reviews/NNN-<name>.md` — the post-implementation code review.
- `adr/NNN-<short-slug>.md` — one per significant technical decision made in this spec (zero or more). Three-digit numbering, global across the project, not per spec.
- Source files, test files, migrations, configs — the actual implementation.
- An update to `docs/roadmap.md` marking the spec done.
- A single git commit on `main` that lands all of the above.

You do **not** modify `VISION.md`, `ARCHITECTURE.md`, `SLICES.md`, or `specs/NNN-<name>.md` (the spec proper). Specs are authored by a different loop and are inputs here. `docs/roadmap.md` is the only file outside the per-spec folders that this loop modifies.

## How to identify the active spec

The active spec is the lowest-numbered spec in `docs/roadmap.md` that is not yet marked done. The roadmap is the source of truth for spec status; the loop reads it to dispatch work and updates it to record completion.

To skip a spec, the human marks it done in the roadmap. To redo a spec, the human unmarks it in the roadmap, deletes its review file, and reverts its commit.

---

## The single decision you make each iteration

Take **exactly one** of the following actions, in this priority order. Stop after you take one action.

1. **No research doc for the active spec?** Read the spec. Study the parts of the codebase this spec touches and the patterns it will join. Don't try to read everything. Write `research/NNN-<name>.md` using the structure in "Research template" below. Stop.

2. **Research exists but no plan?** Read the research and the spec. Write `plans/NNN-<name>.md` as an ordered checklist of small TDD steps using the structure in "Plan template" below. Each step should be small enough that one iteration can finish it. Stop.

3. **Plan has an unchecked step?** Take the next unchecked step. Run the full red → green → refactor cycle for it:
   - Write a failing test (or, for non-testable steps like Docker config, the equivalent verification — a build that passes, a `tsc --noEmit` that's clean, a config file that parses).
   - Run it. Confirm it fails for the expected reason. **Red.**
   - Implement the smallest change that makes it pass.
   - Run it. Confirm it passes. **Green.**
   - Look for one focused refactor — duplication, awkward names, leaking abstractions. Apply it and re-run the relevant tests. Skip refactor if there's nothing worth doing.
   - If a critical technical decision came up while doing this step (see "When to write an ADR" below), write the ADR now and treat it as part of the same iteration.
   - Mark the step `[x]` in the plan with a one-line note on what landed, including any ADR reference.
   - Do **not** commit during this step. Commits land once per spec, at the end.

   If during the step you discover the plan is wrong (the spec demands something the plan missed; an assumption broke; the step turned out to need a non-trivial detour), **do not power through**. In this same iteration, revise `plans/NNN-<name>.md` to reflect what you've learned — add, reorder, split, or remove steps — and stop without checking off the current step. The next iteration resumes against the corrected plan.

   Stop.

4. **All plan steps checked but full test suite not yet verified?** Run the entire test suite (unit + integration). If it passes, append a `## Test run` section to the plan recording the date, the command run, and the pass count. If it fails, add fix steps to the plan and let the next iteration handle them. Stop.

5. **Tests pass but smoke test not yet performed?** Boot the app per the plan's smoke-test recipe (typically `docker compose up`, then exercise the endpoints and UI paths the spec introduces). If it passes, append a `## Smoke run` section to the plan recording exactly what was checked and what was observed. If it fails, add fix steps to the plan. Stop.

6. **Test run and smoke run both recorded as passing, but no review doc?** Conduct a code review of everything that landed in this spec. Compare the working tree against the spec, the research, and the plan. Look for: missed acceptance criteria, untested branches, dead code, naming drift from the spec, leaking abstractions, security smells, unhandled error paths, doc/code mismatches. Write `reviews/NNN-<name>.md` using the structure in "Review template" below. If the review surfaces a correctness or security issue that should be fixed before handoff, add fix steps to the plan and **do not write the review yet** — let the next iteration handle the fix. Otherwise, save the review and stop.

7. **Review exists but the spec isn't shipped yet?** (`docs/roadmap.md` doesn't mark the spec done, or working tree is dirty, or `HEAD`'s subject doesn't start with `Spec NNN:`.)
   - If `docs/roadmap.md` doesn't yet mark this spec done, update it. Follow whatever format the file already uses — a checkbox, a status column, a section move, whatever's there. Don't reinvent the format. If a previous attempt at this priority already updated the file locally, skip this sub-step.
   - Invoke the commit slash command from `.claude/` (e.g. `/commit`) to land the spec on `main`. The slash command handles staging, message, and any project-specific conventions. Provide it whatever context it needs so the resulting commit's subject starts with `Spec NNN: <Name>` — that prefix is what the active-spec detector keys on. Don't run raw `git commit`; the slash command exists so the project has one way of shipping work.
   - Verify the commit landed (`git log -1`, working tree clean, subject starts with `Spec NNN:`).
   - Output `SPEC DONE` and stop.

If two conditions look true at once, the higher-priority one wins.

---

## When to write an ADR

Write an ADR when the spec makes a technical decision that future specs, future contributors, or future-you will need to understand or revisit. Heuristics:

- A choice between architecturally significant alternatives (library, schema design, protocol, framework feature)
- A deviation from `ARCHITECTURE.md` or a resolution of something it was silent on
- A constraint that other specs will have to respect
- A tradeoff with non-obvious consequences (performance, security, portability, ergonomics)
- Replacing or contradicting a previous ADR

Routine implementation choices — variable names, file layout within an established pattern, which test framework matcher to use — do not warrant ADRs.

ADRs follow the structure in `adr/000-adr-template.md`. Don't reinvent the format. New ADRs are written with status `Accepted`. You do not wait for human approval; the act of writing the ADR and committing the implementation is the approval. The review document lists every ADR introduced by the spec.

**Numbering.** ADRs use three-digit numbering (`001`, `002`, …). The next ADR number is one higher than the highest existing ADR file in `adr/`, ignoring `000-adr-template.md`. Numbering is independent of spec numbering — multiple ADRs can come from one spec, and the same concern can recur across specs.

**Filename.** `adr/NNN-<short-slug>.md`. Slugs are kebab-case and short — three or four words.

**Supersession.** If a new ADR replaces an earlier one, the new ADR's status / header references `Supersedes ADR-NNN` per the template, and in the same iteration you edit the older ADR to change its status to `Superseded by ADR-NNN` with a one-line note on what changed. Both edits ship together in the spec's commit.

---

## Research template (`research/NNN-<name>.md`)

````markdown
# Slice NNN: <Name> — Research

**Spec:** `specs/NNN-<name>.md`

## Summary of what the spec asks for

Two or three sentences. The Observable result and the headline Deliverables.

## Existing code that this spec touches

Paths and short descriptions. For each, note: does it already exist, partly exist, or need to be created from scratch.

## Patterns to follow

How similar things are already done in this codebase — DB migrations, Hono routes, React views, repository layers. If a pattern doesn't exist yet because this is the first spec introducing it, say so and decide on the pattern here.

## Refactors needed before adding the new feature

Things in existing code that should change to make this spec clean. Keep this list short — only refactors that genuinely block or substantially improve the spec.

## Risks and open questions

- Things `ARCHITECTURE.md` is silent on
- Library or tooling unknowns
- Anything where you had to make a judgment call

## Test strategy

- Unit tests planned
- Integration tests planned
- Smoke test outline — the manual end-to-end path that will run at the end of the loop
````

For the very first spec, where there is no codebase yet, the research doc is short and says so explicitly. The discipline of writing it still forces you to look first.

## Plan template (`plans/NNN-<name>.md`)

````markdown
# Slice NNN: <Name> — Plan

**Spec:** `specs/NNN-<name>.md`
**Research:** `research/NNN-<name>.md`

## Steps

Each step is small enough to fit in one loop iteration. Each step ends with a concrete check — a named test passing, or a specific command's output.

- [ ] **Step 1: <name>** — <one-sentence description>. Verification: <test name or command>.
- [ ] **Step 2: <name>** — …
- [ ] …

## Smoke test recipe

The exact sequence the loop will run after all plan steps are checked:

1. `docker compose up -d`
2. `curl -s http://localhost:3737/health` → expect `ok`
3. …

## Test run

(Populated by priority-4 action.)

## Smoke run

(Populated by priority-5 action.)
````

## Review template (`reviews/NNN-<name>.md`)

````markdown
# Slice NNN: <Name> — Review

**Spec:** `specs/NNN-<name>.md`
**Plan:** `plans/NNN-<name>.md`

## Summary

A few sentences. What was built, whether it meets the spec's Observable result, headline test and smoke results, and any decisions the human should be aware of. This stands on its own — it's what gets read first.

## What landed

- DB tables / columns / migrations:
- API endpoints:
- UI views / components:
- Files / modules:
- Other:

## ADRs introduced

- `adr/NNN-<slug>.md` — one-line summary. (Or "None.")

## Test and smoke results

- Test suite: <pass count> passing, <command run>.
- Smoke: <what was exercised, what was observed>.

## Code review notes

Findings from reviewing the diff against the spec and plan: tightening, naming, structure, error handling, tests, edge cases. Be specific but concise. Distinguish:

- **Fixed during this spec** — issues caught in review and addressed before handoff.
- **Followups for later** — non-blocking observations to revisit.

## Decisions worth flagging

Any judgment call made during the spec that the human might have decided differently. Concrete: what the call was, what alternatives were considered, why this one. Cross-link to ADRs where relevant.

## Deviations from spec or architecture

If the implementation deviates from the spec or `ARCHITECTURE.md` in any way, list each deviation with a justification. Empty section is fine and common.
````

The review is meant to be readable in a few minutes. High-level summary first, details after, no padding.

---

## Quality bar

- **TDD where applicable.** Production code is written to make a failing test pass. Exceptions: tooling config (Dockerfile, tsconfig, package.json, vite.config), pure declarative migrations, and trivial JSX scaffolding. For these, the verification is `docker compose build`, `tsc --noEmit`, a clean lint run, or the spec's smoke test — but the step still has a named verification.
- **Use the spec's names verbatim.** If the spec says `documents.amount_edited`, the column is `amount_edited`, the test asserts on `amount_edited`, the API field is `amount_edited`. Cross-spec consistency is what makes future specs line up.
- **Reference, don't duplicate.** Cite `ARCHITECTURE.md` and ADRs by name. Don't re-explain the privacy model in five different docs.
- **Honest about failure.** If a test won't go green for a reason you don't understand, write that into the plan as a fix step and stop. Don't comment out the test, don't loosen the assertion, don't fake the implementation, don't `expect(true).toBe(true)`.
- **Stay inside the spec.** If you notice something the next spec should fix, don't fix it now. Note it as a followup in the review.
- **Smoke test exercises the Observable result.** If the spec's Observable result is "I can click Sync and watch progress", the smoke test clicks Sync and watches progress. It does not test something easier as a substitute.
- **Read-only Gmail discipline.** When this spec touches Gmail, only read endpoints. The build-time check from Spec 003 is the enforcement; you write code that passes it without working around it.
- **No email content in logs, ever.** Subject lines and counts are fine in dev logs; bodies and attachments are not.
- **Best judgment, no pauses.** When a decision needs making, make it. Capture it as an ADR if it's significant, flag it in the review's "Decisions worth flagging" if the human should know. Never stall waiting for input.

---

## Things not to do

- **Don't modify the spec.** If the spec is wrong, write that observation in the review as a followup. Don't edit the spec inline; that's the spec-authoring loop's job.
- **Don't combine actions in one iteration.** One step per iteration. Even when the next step looks trivial, stop after the current one and let the loop pick it up. (ADR creation is the exception: it ships in the same iteration as the step that triggered it, because the ADR documents that step's decision.)
- **Don't skip the research doc.** Even when the spec "looks obvious", writing it forces you to actually look at the codebase before changing it.
- **Don't run the full test suite as a verification step inside step 3.** That's priority 4 and runs once per spec. Per-step verification runs only the relevant tests.
- **Don't write the review until tests and smoke both pass.** The review is the spec's completion artifact and signals "ready for human acceptance". It must reflect a working, tested, smoke-tested app.
- **Don't commit mid-spec.** Commits land in priority 7, once, after the review is written and the roadmap is updated. No WIP commits, no per-step commits.
- **Don't run `git commit` directly.** Use the commit slash command in `.claude/`. The project has one way of shipping work; use it.
- **Don't create branches.** All work happens on `main`. No feature branches, no PRs in the loop's flow.
- **Don't reinvent the roadmap format.** Read `docs/roadmap.md` and follow its existing format when marking the spec done. Don't restructure the file.
- **Don't ask the human anything.** No `(?)` markers, no "should I…" questions, no waiting. Decide, document, move on.
- **Don't start the next spec.** When `LOOP DONE` fires, you stop. The human chooses when the next loop run begins.

---

## Done

The current run of the loop is finished when `reviews/NNN-<name>.md` exists for the active spec, the spec is marked done in `docs/roadmap.md`, the spec's commit is on `main`, and `LOOP DONE` has been output. Do not begin work on the next spec in the same loop run.

If every spec in `docs/roadmap.md` is marked done with a corresponding `Spec NNN:` commit on `main`, output `LOOP DONE` and stop without writing anything.
