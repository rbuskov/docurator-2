# ADR-007: SSE for sync progress with an in-memory ring buffer

**Status:** Accepted
**Date:** 2026-05-09
**Supersedes:** —
**Spec:** `docs/specs/006-sync-and-store-receipts.md`

## Context

Slice 006 introduces the sync orchestrator — a long-running per-account loop that fetches messages, runs the classifier, and persists receipts. The Dashboard needs to surface live progress as it happens (per-account counters, the currently-processing message, errors); after `sync.done` the user moves on. `architecture.md` § "Sync (manual trigger)" calls for "Server-Sent Events or WebSocket"; the spec's API surface lists `GET /api/sync/events` as the streaming channel.

Three things shape the choice:

- **One sync at a time.** Slice 006's mutex makes the orchestrator a singleton in the Node process; there is no fan-out across machines.
- **Single-process, browser-driven UI.** The only consumer is the user's own browser tab(s). No external integrators, no third-party push targets.
- **Late subscribers exist.** The user can click "Sync now" and then refresh the Dashboard, or the UI can mount the events stream a beat after `POST /api/sync` returns. They need to see what already happened, not just what comes next.

## Decision

**Use Server-Sent Events for streaming sync progress, backed by a module-scoped in-memory ring buffer of the last `RING_CAPACITY = 200` events.** New subscribers replay the ring buffer's contents as the first iterations of their async iterator, then wait on live emits.

The implementation lives in `src/server/sync/events.ts`. It exports a typed `syncEvents` singleton with three methods: `emit(event, payload)` records to the ring and pushes to live subscribers, `subscribe(): AsyncIterable<SyncEvent>` returns an async iterator that first replays the ring then yields live events, and `recent(): SyncEvent[]` returns a snapshot of the ring (used by `GET /api/sync/status`). The HTTP route in Slice 006's Step 17 wraps `subscribe()` in a Hono SSE response. Subscribers are tracked in a `Set` that the iterator's `return()` hook removes itself from on close.

## Consequences

**Easier:**
- The browser can use the native `EventSource` API — built-in reconnect, automatic event-stream parsing, no client library.
- The orchestrator emits a single typed call site (`syncEvents.emit('sync.message', { ... })`) that's trivial to test (the ring buffer + subscribe-and-collect pattern works without mocking timers).
- Late subscribers don't miss the early per-account events of a job already in flight.
- The server side stays in plain Node — no WebSocket library, no extra `ws` runtime dep, no per-connection upgrade handshake.

**Harder:**
- A container restart loses the ring. In-flight jobs survive only as far as the persisted `processed_messages` rows go; the user has to re-run sync to see fresh progress events. Acceptable in this single-user tool — `architecture.md` § "Components — Backend — Sync handler" already accepts mid-sync restart as a non-recovery scenario.
- The ring is fixed at 200 events. A sync that processes 5,000 messages emits more events than the ring holds; late subscribers see the most recent 200 only. The UI's job is "what's happening right now," not "audit log" — the Audit view (Slice 010) reads from `processed_messages` for that.
- One subscriber that doesn't drain its iterator can grow that subscriber's queue without bound. The Hono SSE route's `return()` hook on connection close removes the subscriber, so this only matters if a subscriber stays connected but stops reading. Acceptable in v1; revisit if it surfaces.

## Alternatives considered

- **WebSocket.** Bidirectional, but we don't need bidirectional — the only direction is server → browser. Adds a dependency (`ws`), an upgrade handshake, and a layer of framing the browser's `EventSource` already gives us for free. Rejected.
- **Long polling.** Workable, but every poll is a fresh HTTP request and the server has to track last-seen-event-id per client; the ring buffer plus replay-on-subscribe gives the same property with one persistent connection. Rejected on cost-of-connection grounds.
- **Persisted event log (a `sync_events` SQLite table).** Survives restart, supports arbitrary replay windows. Rejected because (a) the events are duplicative of `processed_messages` rows the orchestrator already writes, (b) "what's happening right now" doesn't need to be archival, and (c) Slice 010's Audit view already supplies the persistent view. Adding a parallel store would invite drift between the two and burn write budget on data the user doesn't need to query historically.
- **Larger ring (1,000+ events).** Cheap in memory but would mostly just defer the same problem. 200 fits comfortably in a single screen of audit-style detail and is a generous buffer for a UI mount that lags `POST /api/sync` by tens of milliseconds. Easy to bump if the smoke run shows the cap clipping useful information.
- **No ring, push-only.** Simpler, but late subscribers would see "nothing happening" while the orchestrator is mid-sync, which is exactly the case the Dashboard mounts in. Rejected.

## Supersession

—
