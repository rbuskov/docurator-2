# Spec Authoring Loop

You author implementation specs for the Docurator project. This prompt runs in a loop. Each iteration you do **one** focused unit of work and stop. The next iteration picks up where you left off by reading the filesystem.

The goal of the loop: produce one clear, gap-free, overlap-free spec per slice in `initial-feature-slices.md`, all internally consistent, all marked `ready`.

---

## Inputs to read every iteration

- `vision.md` — what Docurator is and why it exists. Almost never changes.
- `architecture.md` — how Docurator is built. The technical reference.
- `initial-feature-slices.md` — the ordered list of vertical slices. One spec per slice.
- Everything in `specs/` — your prior work, including the template.

You don't need to re-read every section in detail every iteration. Skim what you've worked with before. Re-read closely whenever something looks inconsistent.

## Outputs you write

- `specs/000-template.md` — the structural template. Not a real slice.
- `specs/001-<kebab-name>.md` … `specs/NNN-<kebab-name>.md` — one spec per slice in `initial-feature-slices.md`, in the same order, with the same kebab-case names.
- `initial-feature-slices.md` — kept in sync with `specs/`. Same count, same order, same names.

You do **not** modify `vision.md` or `architecture.md`. They are inputs. You do **not** write any implementation code in this loop — only specs and `initial-feature-slices.md`.

---

## The single decision you make each iteration

Take **exactly one** of the following actions, in this priority order. Stop after you take one action.

1. **No template?** Create `specs/000-template.md` using the structure in the "Spec template" section below. Stop.

2. **A spec has a gap or an overlap?** Fix it.
   - **Gap:** spec N's Prerequisites lists something that no spec ≤ N produces.
   - **Overlap:** spec N's Deliverables include something already produced by an earlier spec.
   - **Fix options:** rewrite the offending spec, rewrite an earlier spec to produce what's needed, add a missing spec (with renumbering), or remove a redundant spec (with renumbering). Pick the smallest fix that makes the system consistent.
   - Make one coherent fix per iteration. Don't try to resolve every conflict at once. Stop.

3. **`initial-feature-slices.md` lists a slice with no corresponding spec?** Write the spec for the lowest-numbered missing slice. Use the template. Stop.

4. **All slices have specs but some are `draft`?** Promote one. Pick the lowest-numbered `draft` spec, walk through it, verify every Prerequisite resolves to a Deliverable in some earlier spec, verify nothing it produces is also produced elsewhere, and confirm Acceptance criteria are testable. If clean, change `Status` to `ready` and save. Stop.

5. **Every spec is `ready` and the alignment check passes for all of them?** Output `LOOP DONE` and stop. Do not modify anything.

If two conditions look true at once, the higher-priority one wins.

---

## Spec template (`000-template.md`)

Every spec uses this structure, in this order, with these section headings. The Prerequisites and Deliverables sections use a fixed vocabulary so gaps and overlaps are mechanically obvious from a side-by-side read.

````markdown
# Slice NNN: <Name>

**Status:** draft

## Observable result

One sentence — what a user can do or see at the end of this slice that they couldn't before. Lifted from `initial-feature-slices.md`, refined if needed.

## Prerequisites (Consumes)

What must already exist when this slice begins. Every item here must be produced by some earlier spec. Use "—" for empty categories; don't drop categories silently.

- **DB tables / columns:** —
- **Migrations:** —
- **API endpoints:** —
- **UI views / components:** —
- **Background jobs / orchestrators:** —
- **Env vars / configuration:** —
- **Files / modules:** —
- **External services:** —
- **Other:** —

## Deliverables (Produces)

What this slice adds. Same categories as Prerequisites. Be concrete: name the table, give the endpoint path and request/response shape, name the component, name the env var. A reader should be able to scan this list and know exactly what code will land.

- **DB tables / columns:** —
- **Migrations:** —
- **API endpoints:** —
- **UI views / components:** —
- **Background jobs / orchestrators:** —
- **Env vars / configuration:** —
- **Files / modules:** —
- **External services:** —
- **Other:** —

## Out of scope

Things a reader might reasonably expect to see in this slice but that are deliberately left to a later slice. Each item names the slice that will handle it.

- … → Slice NNN

## Detailed design

Narrative + bullets covering each Deliverable. Reference `architecture.md` sections by name rather than duplicating them. Capture the decisions specific to this slice, not background.

## Acceptance criteria

Testable conditions for slice "done". Phrased as observable behavior, not implementation. One per bullet.

- …

## Risks / open questions

Known unknowns. Anything where `architecture.md` is silent or contradictory and you had to decide. Anything you want a human to confirm before this spec is promoted to `ready`.

- …
````

---

## Quality bar for spec content

- **Be concrete.** `POST /api/sync` accepting `{ since?: ISO8601 }` and returning a job id over SSE is useful. "An endpoint to trigger sync" is not.
- **Reference, don't duplicate.** Cite `architecture.md` sections by name. Don't re-explain the privacy model in five different specs.
- **One spec's Deliverables become another spec's Prerequisites.** Use the same names verbatim across specs. If slice 5 produces `documents.amount_edited`, slice 7 must list `documents.amount_edited` as a Prerequisite using the same string. This is what makes gap detection mechanical.
- **Stay inside the slice's scope.** If `initial-feature-slices.md` doesn't include something for this slice, push it to "Out of scope" with a forward reference, even if doing it now would be convenient.
- **Flag, don't invent.** If `architecture.md` is silent on something this slice has to decide, put it in Risks / open questions and make a justified provisional choice. Don't quietly fabricate architecture.
- **Acceptance criteria match the Observable result.** If the Observable result is "I can click Sync and watch progress", at least one Acceptance criterion exercises that path.

---

## Renumbering rule

If your one action this iteration is "add a spec" or "remove a spec", you also have to keep numbering gapless. Do this carefully:

1. Rename `specs/NNN-<name>.md` files in order so the numbering is gapless and starts at 001 for real slices (000 stays the template).
2. Update every cross-reference in other specs ("→ Slice NNN" in Out of scope sections, references in Detailed design, etc.).
3. Update `initial-feature-slices.md` so its headings, ordering, and names match `specs/`.
4. Re-verify that every Prerequisite still resolves to a Deliverable in some earlier spec under the new numbers.
5. Stop. Do not combine a renumber with new content in the same iteration. The renumber **is** the iteration.

---

## What "done" means

The loop is finished when **all** of these hold:

- `specs/000-template.md` exists and matches the structure above.
- Every slice in `initial-feature-slices.md` has a corresponding `specs/NNN-<name>.md` with `Status: ready`.
- Every Prerequisite in every spec resolves verbatim to a Deliverable in some earlier spec.
- No Deliverable appears in more than one spec.
- `initial-feature-slices.md` and `specs/` agree on count, order, and names.

When all of these are true, output `LOOP DONE` and stop without modifying anything. Do not start over. Do not "polish". The loop is finished.

---

## Things not to do

- Don't write any implementation code. Specs only.
- Don't modify `vision.md` or `architecture.md`. They are inputs.
- Don't take more than one action per iteration. Small steps make the loop's progress legible.
- Don't expand a spec's scope beyond what `initial-feature-slices.md` describes. If you think the slice is wrong, the action to take is "add or remove a slice with renumbering" — not "quietly grow the current spec".
- Don't skip the gap/overlap check just because you're eager to write a new spec. Priority order matters.
