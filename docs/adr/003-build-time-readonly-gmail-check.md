# ADR-003: Build-time read-only Gmail check via substring scan

**Status:** Accepted
**Date:** 2026-05-09
**Supersedes:** —
**Spec:** `docs/specs/003-see-my-emails-listed.md`

## Context

`docs/architecture.md` § "Read-only Gmail access" and § "Security notes — CI enforcement" promise that Docurator never writes to any connected Gmail account, and that this property is enforced at build time so it cannot be accidentally violated by a future change. `docs/vision.md` foregrounds this guarantee in the privacy story ("not because we promise we won't, but because we never asked Google for the capability").

Slice 003 is the first slice that actually calls Gmail (`users.messages.list` + `users.messages.get` via `googleapis`). It is therefore also the first slice where a regression — a careless `users.messages.modify` call, an exploratory `drafts.create` left behind in a feature branch — could materially break the read-only guarantee. The architecture document calls out the enforcement explicitly:

> add a build-time check that scans the codebase for forbidden Gmail API method names (`messages.modify`, `messages.trash`, `messages.delete`, `messages.send`, `labels.create`, `labels.delete`, `drafts.*`, etc.). Any match fails the build.

This ADR records the shape of that check.

## Decision

Use a **literal-substring scanner** as the enforcement mechanism. A self-contained script (`scripts/check-gmail-readonly.ts`) walks `src/` recursively, reads each `.ts` / `.tsx` / `.js` / `.jsx` file, and checks for any of a fixed list of forbidden substrings (24 entries from the spec, covering `users.messages.{modify,trash,delete,send,insert,import}`, `users.labels.{create,delete,update,patch}`, `users.drafts.{create,update,delete,send}`, `users.threads.{modify,trash,delete}`, plus the Gmail-write OAuth scope substrings `gmail.{modify,send,compose,insert,metadata,labels,settings.basic,settings.sharing}`). On any hit the script exits non-zero with a per-hit `FAIL:` line naming the file path and the offending substring; on no hits it exits 0 with `OK: no forbidden Gmail-write substrings in src/`.

The script is wired into `package.json` as `npm run check:gmail-readonly` and is the **first** step of `npm run build`. Because the Dockerfile's builder stage runs `npm run build`, the check is enforced on every container build (and therefore every `docker compose up --build`). A vitest test (`scripts/check-gmail-readonly.test.ts`) runs the same scanning function against a variety of fixture trees plus the real `src/` directory — so a regression is caught at `npm test` time too, without anyone having to remember to run the build.

The script self-exempts: it strips its own absolute path from the file list before scanning, so its declaration of the FORBIDDEN constants does not trigger itself. The exempt path is the **single** literal `scripts/check-gmail-readonly.ts`; no directory-level exemption, no comment-marker like `// eslint-disable-next-line`. Markdown and other non-code files under `docs/` are out of scope by file-extension filtering.

## Consequences

- **Cheap to run.** A single recursive `readdirSync` plus 24 substring checks per file. On the current codebase (~30 source files) the check completes in ~30 ms; the 50 ms it adds to a Docker build is invisible against the rest of the build.
- **Catches mistakes regardless of how they got into the file.** The scanner doesn't care whether `messages.modify` is in source code, in a comment, in a string literal, or in a JSDoc block. The architecture treats the *presence* of the string as enough to fail the build, since false positives are easy to fix (rename the comment) and the cost of a false negative (a real write call slipping through) is higher.
- **Substring matching is dumb on purpose.** It deliberately does not understand TypeScript syntax. This is a feature, not a bug — a sophisticated AST-based check would have a larger maintenance surface, would be harder to read for a future contributor wondering what's enforced, and would still miss bypass patterns like `gmail['users']['messages']['modify']` that aren't statically resolvable. The substring scan catches the obvious cases, the small set of bypass patterns that an attacker could deliberately construct are the same patterns a code review would flag.
- **No bypass via comment.** A contributor cannot disable the check on a per-file basis. The only way to suppress a hit is to remove the substring from the file. This matches `architecture.md`'s "false positives are addressed by fixing the comment, not loosening the check" stance.
- **Constraint imposed on later specs.** All Gmail API access goes through `src/server/gmail/client.ts` (or its successors) using only the read methods. New methods that need write capability are forbidden by Docurator's architecture; this check is the enforcement. If a future feature ever needed write access (e.g. labelling), it would require both a vision/architecture change *and* either editing the FORBIDDEN list or accepting a deliberate exception path here — a substantial enough change to require its own ADR.
- **`gmail.metadata` and `gmail.labels` are caught even though they are not "write" scopes.** They are scopes that *expand* read access (the spec lists them), and Docurator deliberately uses only `gmail.readonly`. The substring list mirrors `architecture.md` § "Read-only Gmail access" verbatim — including these scope-narrowing forbidden patterns — so the check enforces "no Gmail scope other than `gmail.readonly`, `userinfo.email`, `openid`" as a side effect.
- **Maintenance cost.** The FORBIDDEN list is duplicated (deliberately) from the comments above and from `architecture.md`. Adding a new forbidden pattern is a one-line edit in `scripts/check-gmail-readonly.ts`. Removing one would require a corresponding architecture change and an ADR update.

## Alternatives considered

- **ESLint custom rule (`no-restricted-syntax`)** — would require keeping ESLint configured for the project (currently we have none), would only catch syntactic patterns it knows how to match, and would be invisible to anyone reading the rule's TypeScript implementation. The substring scan is shorter and more readable.
- **`eslint-plugin-no-restricted-imports`** — only enforces import paths, not arbitrary string occurrences. A `users.messages.modify(...)` call uses no special import; the violation is an attribute access on a returned client. Misses the actual threat.
- **`ts-morph` / AST-based scanner** — could match `gmail.users.messages.modify(...)` more precisely than substring matching, at the cost of a much larger script and a heavier dev-dep. The marginal precision is not worth the maintenance surface for a guard that fires on a tightly-constrained set of patterns the codebase otherwise has zero need for.
- **Pre-commit hook only** — could prevent commits but not pulls or CI failures, and would silently disappear if a contributor disabled hooks. Build-time enforcement is the more durable place. (We could add a pre-commit hook in addition; that's not in scope here.)
- **No check, code review only** — explicitly rejected by `architecture.md` § "Security notes" ("This should be enforced by code review and ideally by a lint rule or test that fails the build if a write endpoint is referenced"). Code review alone is insufficient for an architectural property this load-bearing.
- **Runtime check (intercepting the `googleapis` client)** — would not prevent the offending code from shipping, only from running. By that point the binary is already in the user's hands. Build-time is the right phase.

## Supersession

—
