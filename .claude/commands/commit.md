---
description: Create a git commit using the project commit template
---

# Commit Changes

You are creating a git commit for the changes made in this session. Use the commit template below. The body should be **fairly detailed** — substantially more than a one-line summary, but **not** a file-by-file walkthrough of the diff.

## Process

1. **Inspect the working tree.**
   - `git status` to see what's staged and unstaged.
   - `git diff` (and `git diff --staged` if anything is already staged) to understand the actual changes.
   - If the changes are logically distinct (e.g. an unrelated refactor mixed with a feature), propose splitting into multiple commits before writing any messages.

2. **Draft the commit message** using the template below. Fill it in from your understanding of the conversation and the diff — not by paraphrasing the diff line by line.

3. **Just commit.** The user trusts your judgment — do not ask for confirmation, do not present a plan for approval, do not wait. Go straight to staging and committing.
   - Stage with explicit paths (`git add path/to/file …`). Never `git add -A` or `git add .`.
   - Commit using a HEREDOC so the body formats correctly.
   - Run `git log -1 --stat` afterward to show what landed.

## Commit template

```
<subject: imperative, lowercase, no trailing period, ≤ 60 chars>

<Why — 1–3 sentences. What problem prompted this change, what
goal it serves, or what was broken/missing before. A reader who
hasn't seen the diff should understand the motivation from this
paragraph alone.>

<What — 2–5 sentences. The shape of the change at a conceptual
level: the approach taken, the key pieces introduced or removed,
and any decision that isn't obvious from reading the code (why
this design, not the alternative). Reference modules or
components by name where it adds clarity. Do *not* enumerate
every changed file or restate the diff.>

<Notes (optional) — trade-offs accepted, things deliberately left
out, or follow-ups that this commit sets up but does not finish.
Omit this paragraph entirely if there's nothing to say.>
```

### What the body should and shouldn't contain

**Should:**
- The motivation / trigger for the change.
- The chosen approach and why it was chosen over the obvious alternative.
- Anything a future reader (including you in six months) would need to make sense of the diff.
- Forward references to follow-up work this commit enables.

**Shouldn't:**
- A file-by-file or function-by-function summary.
- Restating identifiers, signatures, or logic that the diff already shows.
- Marketing fluff ("this beautifully refactors…").
- Tutorials on concepts the reader can be assumed to know.

Aim for a body of roughly 6–14 lines of prose. If you find yourself writing more, you're probably re-narrating the diff; cut.

## Subject conventions

- Imperative mood: "add sync endpoint", not "added" or "adds".
- Lowercase first letter, no trailing period.
- ≤ 60 characters. If you can't fit it, the commit is probably doing too much.
- No type prefix (`feat:`, `fix:`, etc.) unless the user has asked for one.

## Rules

- **Never** add `Co-Authored-By`, "Generated with Claude", or any attribution line. The commit is authored solely by the user.
- **Never** use `git add -A`, `git add .`, or `--no-verify` unless the user explicitly asks.
- **Never** amend an existing commit unless the user explicitly asks. If a pre-commit hook fails, fix the underlying issue and create a new commit.
- If a hook rewrites or rejects your commit, investigate the root cause — don't bypass it.

## Example (shape only — not the wording to copy)

```
add sync endpoint and SSE progress stream

The desktop client previously had no way to trigger a manual
sync; users had to wait for the scheduled job. We need an
on-demand path so QA can reproduce ingestion bugs without
waiting up to an hour.

Adds POST /api/sync, which enqueues a sync job and returns a job
id. Progress is streamed over SSE at /api/sync/:id/events using
the existing job-bus channel rather than a new transport, so the
worker side needed no changes. The job id is a ULID rather than
the DB row id to avoid leaking row counts.

Auth is intentionally unchanged in this commit; the endpoint
inherits the session-cookie middleware. Rate limiting is left
for the follow-up slice that adds the UI button.
```
