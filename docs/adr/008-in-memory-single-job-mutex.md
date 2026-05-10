# ADR-008: In-memory single-job mutex for the sync orchestrator

**Status:** Accepted
**Date:** 2026-05-09
**Supersedes:** —
**Spec:** `docs/specs/006-sync-and-store-receipts.md`

## Context

Slice 006 introduces the sync orchestrator — a long-running per-account loop that fetches messages, runs the classifier, and persists receipts. The spec requires "one user, one sync at a time"; `architecture.md` § "Goals & non-goals" lists "multi-user / multi-tenant" and "multi-job concurrency" as v1 non-goals. We need a mechanism that:

- Returns `409 sync_in_progress` from `POST /api/sync` if a sync is already running.
- Tells `GET /api/sync/status` whether a job is active and what its `job_id` is.
- Releases the lock when the orchestrator finishes (success, error, or any unhandled throw).
- Doesn't introduce a new persistence surface that would have to be reasoned about during partial failure or container restart.

The orchestrator is a single function in a single Node process; the user is one person on one machine; container restart drops in-memory tokens, in-memory SSE subscribers, and (per Slice 006's "no persisted job state" stance) any in-flight sync. The next sync resumes naturally from `processed_messages` — the orchestrator skips messages already processed for `(account_id, message_id)` (`existsForMessage` from Slice 004's repo).

## Decision

**Use a module-scoped variable in `src/server/sync/orchestrator.ts` to track the currently-active job; reject a second `runSync` with `SyncInProgressError` while the variable is non-null.** The variable holds `{ job_id, started_at }` for the lifetime of the active job; the orchestrator's outer `try/finally` clears it when the work completes or throws.

Implementation:

- `let activeJob: { job_id, started_at } | null = null` at the top of `orchestrator.ts`.
- `runSync(args, deps)` checks `activeJob` synchronously at entry; if non-null, throws `SyncInProgressError(activeJob.job_id)` before any state change. Otherwise sets `activeJob = { job_id, started_at }` and proceeds.
- The actual work runs inside an immediately-invoked async IIFE returned as `done`. The IIFE wraps everything in `try/finally`; the `finally` clears `activeJob = null`.
- `getActiveJob(): { job_id, started_at } | null` exports the current value for `GET /api/sync/status`.
- `__resetActiveJobForTest()` exists so tests don't leak orchestrator state across files.

## Consequences

**Easier:**
- Trivial to test — the mutex check is a synchronous read of a module-scoped boolean.
- No new schema, no new migration, no race conditions in the DB layer.
- The `409` response is a single throw site that the API route catches and maps; no DB query on the request path.
- `getActiveJob()` is O(1) — `GET /api/sync/status` returns instantly without querying the DB.

**Harder:**
- A container restart mid-sync drops the `activeJob` variable. If the user clicks "Sync now" twice and the first invocation crashes the process before `finally` runs, the second click would proceed (the lock is gone). Acceptable: classifier crashes shouldn't take the whole process down, and if they do, "second sync replays from where the first left off" is the intended behavior — `processed_messages` idempotency makes this safe.
- Multiple Node processes (e.g. a future horizontally-scaled deployment) would not coordinate. Out of scope: `architecture.md` rules out multi-process and multi-tenant for v1.
- `__resetActiveJobForTest` exists as a test seam in production code. Acceptable: same shape as `setSessionClientFactoryForTest` in `auth/session.ts` and `setInvoicesRootForTest` in `files.ts`. Slice 016 may consolidate the test seams behind a shared tag if they proliferate.

## Alternatives considered

- **DB-backed `jobs` table.** A row per job with `status`, `started_at`, `finished_at`. Survives restart, supports cancellation tokens, makes the lock visible across processes. Rejected because (a) restart-recovery isn't a v1 requirement and a half-finished sync's reattempt is already idempotent, (b) it adds a write-on-every-job-event cost (or we accept stale rows on crash) without a use case that needs the visibility, and (c) it's the wrong tool for "we don't allow concurrency" — it's the right tool for "we allow some concurrency and need a queue."
- **Filesystem lockfile.** `./data/sync.lock` written at start, removed at end. Survives restart in the bad direction (a stale lockfile blocks future syncs), and the cleanup-on-crash story is no better than the in-memory variant. Rejected.
- **`Promise`-based mutex utility (`p-limit`, `async-mutex`).** Would do the job but adds a dependency for what is one if-statement and a try/finally. Rejected on dependency-surface grounds.
- **No mutex; let two orchestrators run concurrently.** Each per-message transaction has the existing `existsForMessage` idempotency check, so duplicate work would be detected and skipped — but two orchestrators would still both fetch from Gmail, both call the classifier (wasted Ollama time), and emit overlapping SSE events that would confuse the UI's per-account counters. Rejected — concurrency in v1 buys no value and costs UI clarity.

## Supersession

—
