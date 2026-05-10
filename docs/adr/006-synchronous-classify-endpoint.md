# ADR-006: Synchronous per-message classify endpoint with long timeout

**Status:** Accepted
**Date:** 2026-05-09
**Supersedes:** —
**Spec:** `docs/specs/005-classify-one-email-end-to-end.md`

## Context

Slice 005 introduces the first endpoint that calls Ollama (`POST /api/accounts/:id/messages/:message_id/classify`). The work it does — fetch the full Gmail message, decode + render attachments, build the multimodal prompt, call the vision model, parse the response — can take tens of seconds on a CPU-bound host. The spec § "Implementation notes" sets `OLLAMA_TIMEOUT_MS=120000` (2 minutes) as the default per-request timeout for exactly this reason.

`docs/architecture.md` § "Components — Gmail sync handler" describes the *batch* sync flow as streaming progress to the UI via Server-Sent Events or WebSocket; that's Slice 006's territory. For Slice 005, the user invokes one classification at a time by clicking "Classify" on a single Inbox row; there is no batch, no queue, no need for incremental progress beyond "spinner spinning" until the verdict arrives.

The shape of this endpoint sets the pattern for every subsequent per-message classify-style action — Slice 010's per-row "Reclassify" in the Audit view, Slice 014's batch reclassification (which delegates per-message work to the same call), any future single-message inference. The decision is small but durable.

## Decision

The classify endpoint is **a single synchronous HTTP POST** that holds the connection open until the pipeline returns (or `OLLAMA_TIMEOUT_MS` aborts the Ollama call). The response body carries the verdict directly. No SSE, no WebSocket, no progress events, no polling endpoint, no background-job + result-id pattern.

The timeout is configurable via env var (`OLLAMA_TIMEOUT_MS`, default 120000) but is not user-tunable per-call. The Ollama HTTP client (`src/server/classify/ollama.ts`) wraps `fetch` in an `AbortController` that fires the timeout server-side, surfacing as `OllamaUnreachableError` (HTTP 503) to the UI.

## Consequences

- **Simplest possible UI surface.** The React component (`ClassifyRowAction.tsx`) issues a single `fetch`, shows a spinner while pending, renders the verdict on resolve. No event-source bookkeeping, no reconnection logic, no per-row state machine beyond `idle → pending → success | error`.
- **Browser keep-alive ~2 minutes.** Modern browsers don't time out fetch calls, but corporate network appliances might cut idle TCP after ~60 s. v1 is localhost-only (the user runs the container on their own machine, opens `http://localhost:3737` in their browser, and there's nothing in between); this is a non-issue for the v1 deployment shape. A future hosted-mode would need to revisit.
- **Single request occupies a Node connection slot for up to 120 s.** `@hono/node-server` defaults to unlimited concurrent connections (the Node socket accept limit dominates). For a single-user tool, the only competing requests are the Dashboard's 30 s health-badge poll and the user's own UI navigation — both light and short-lived. Acceptable.
- **No partial progress visible.** During the wait, the UI shows a spinner; it cannot show "fetching attachment 2 of 3" or "rendering page 4 of 5". For the spec's per-message Observable result this is fine — the user clicks one button and waits seconds. Slice 006's batch sync (which can take minutes across hundreds of messages) gets SSE because the wait is meaningful and visible progress matters.
- **Server-side timeout via `AbortController`, not Hono middleware.** The timeout wraps just the Ollama call (the longest leg); Gmail fetches and PDF rendering have no explicit timeout this slice. If Gmail hangs, the request hangs until the Node socket's keep-alive fires; if PDF rendering OOMs, Node crashes. Both are acceptable for v1's tightly-scoped pipeline and explicitly flagged as future-work in Slice 005's research.
- **Predictable error mapping.** Three Ollama failure modes (unreachable, HTTP non-2xx, parse failure) map to three HTTP statuses (503, 502, 502) with distinct error codes (`ollama_unreachable`, `ollama_http_error`, `ollama_parse_error`). The UI branches on status + error code; no need to interpret event-stream messages.
- **Constraint imposed on later specs.** Slice 010's per-row Reclassify reuses this same endpoint shape (synchronous POST per message). Slice 014's batch reclassify orchestrates many synchronous classify calls behind an SSE-streamed batch endpoint; it does *not* parallelize them (Ollama on the host is the bottleneck and overlapping inference doesn't help — `architecture.md` § "Sync (manual trigger)" pins this).
- **`OLLAMA_TIMEOUT_MS` is generous.** A 30 s default would catch the 99th percentile but cut off legitimate slow inferences on under-resourced hosts (e.g. a freelancer running this on an old laptop). 2 minutes errs toward "let it complete" — false aborts cost the user a click; under-aborts cost nothing. Tunable per-install for users with faster hardware.
- **No retry-on-timeout.** A timeout returns 503; the UI's Retry button issues a fresh request. Intentional — the model may have been mid-response, and silently retrying would double the work without any guarantee the second attempt is faster.

## Alternatives considered

- **SSE / streaming progress.** Right answer for batch sync (Slice 006) where the user is watching a long-running operation across many messages. Wrong answer for one message: the only meaningful progress event is "verdict ready", which is what the synchronous response already carries. Adds an EventSource bookkeeping layer to the UI for no value.
- **Polling: POST returns a job id immediately, GET retrieves the result.** Reduces the per-request connection time at the cost of a job-state table (or in-memory map) and a polling cadence the client has to pick. The job-state table is non-trivial — it needs cleanup, expiry, ownership keying. For one in-flight classify per user, the synchronous request *is* the job state. Premature.
- **WebSocket for the classify channel.** Permanent connection, push updates. Same overkill as SSE — and worse, it opens connection-lifecycle questions (what if the socket reconnects mid-classify?) that the synchronous request sidesteps entirely.
- **Background job + email notification when done.** Wrong product. The user is sitting at the UI watching for the verdict; pushing an email or webhook adds nothing.
- **Shorter default timeout (e.g. 30 s) with retry.** Hides slow inferences from the user, doubles the work on the model (the abandoned attempt may have been seconds from completing). The UI's Retry button gives the user control; the system's defaults err toward completion.
- **No timeout — let the Node socket keep-alive decide.** The platform default is implementation-specific and easy to misread on incident; an explicit timeout in code is the contract.

## Supersession

—
