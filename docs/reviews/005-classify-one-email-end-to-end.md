# Slice 005: Classify one email end-to-end — Review

**Spec:** `docs/specs/005-classify-one-email-end-to-end.md`
**Plan:** `docs/plans/005-classify-one-email-end-to-end.md`

## Summary

Slice 005 lands the classification pipeline end-to-end: a multimodal Ollama call orchestrated by `src/server/classify/index.ts`, exposed via a new synchronous `POST /api/accounts/:id/messages/:message_id/classify`, with no DB writes anywhere. Five new server modules under `src/server/classify/` (orchestrator, Ollama HTTP client, prompt builder, body extractor, attachment-metadata extractor, PDF→PNG renderer, and Zod schemas) compose with two new HTTP routes (`POST .../classify`, `GET /api/ollama/health`) and two new client components (`OllamaHealth`, `ClassifyRowAction`) that wire into the existing Dashboard and Inbox views. Five new runtime deps land — `zod`, `@hono/zod-validator`, `pdfjs-dist`, `@napi-rs/canvas`, `node-html-parser`. Three small refactors close longstanding duplications (`isInvalidGrantError`, the account-status preconditions). Three ADRs ship: ADR-004 (server-side PDF rendering via `pdfjs-dist + @napi-rs/canvas`), ADR-005 (prompt as a TypeScript constant), ADR-006 (synchronous classify endpoint with long timeout).

The spec's Observable result — "click Classify on a real Inbox row → see Ollama's verdict inline within seconds" — is satisfied at the unit-test layer end-to-end and at the smoke layer for everything verifiable from the agent shell. **Browser-driven AC #1-#5 are deferred to human acceptance** (the agent has neither a real browser nor a reachable Ollama in its network); the contract is fully pinned at the unit-test layer with 122 new tests landing this slice. AC #6 (no DB writes), AC #7 (`check:gmail-readonly`), AC #8 (health endpoint within 5 s), and AC #9 (no Gmail OAuth scope other than `gmail.readonly`) are all verified end-to-end.

One small build-time issue surfaced and was fixed during the smoke step: `tsconfig.server.json` needed `DOM` added to its `lib` so `pdfjs-dist`'s `CanvasRenderingContext2D` type reference resolves at server-build time. Compile-time only — Node's runtime still has no `window`/`document`. Flagged below.

## What landed

- **DB tables / columns / migrations:** —
- **API endpoints:**
  - `POST /api/accounts/:id/messages/:message_id/classify` (200 verdict, 400 on path-param failure, 401 on `invalid_grant`, 404 on unknown account, 409 on `needs_reauth`, 502 on `ollama_parse_error` / `ollama_http_error` / generic `gmail_error`, 503 on `ollama_unreachable`).
  - `GET /api/ollama/health` (always 200; body's `reachable` field carries the failure signal).
- **UI views / components:**
  - `src/client/components/OllamaHealth.tsx` — three pill states (`ready` / `model_missing` / `unreachable`), 30 s polling via `setInterval` cleaned up on unmount, `data-state` + `data-testid` attributes for stable test selectors.
  - `src/client/components/ClassifyRowAction.tsx` — per-row state machine (`idle | pending | success | unreachable | parse_error | http_error | needs_reauth | error`), Retry affordance for transient errors, `<details>` block surfacing the raw response on parse errors.
  - `src/client/views/Dashboard.tsx` — extended with `<OllamaHealth />` between the alert paragraph and the AccountList.
  - `src/client/views/Inbox.tsx` — extended with a fourth `<th>Classify</th>` column rendering `<ClassifyRowAction>` per row.
- **Files / modules:**
  - `src/server/classify/index.ts` — orchestrator (`classifyMessage`).
  - `src/server/classify/ollama.ts` — Ollama HTTP client (`chat`, `listModels`) plus `OllamaUnreachableError`, `OllamaHttpError`, `OllamaParseError`.
  - `src/server/classify/prompt.ts` — `buildClassificationMessages` plus the `SYSTEM_PROMPT` template-literal constant.
  - `src/server/classify/extract-body.ts` — MIME-tree walker producing `{ text, html_was_used, inline_image_count }`.
  - `src/server/classify/extract-attachments.ts` — MIME-tree walker producing `{ all, receipt_eligible }`.
  - `src/server/classify/render-pdf.ts` — `renderPdfToImages` via `pdfjs-dist` (legacy/Node build) + `@napi-rs/canvas`.
  - `src/server/classify/schema.ts` — `classificationSchema`, `artifactSchema`, `classifyResponseSchema`.
  - `src/server/classify/__fixtures__/sample.pdf` (13.6 KB, 2 pages) plus `generate-sample.ts` (the one-shot script that produced it; committed for reproducibility).
  - `src/server/api/classify.ts` — the POST route + `@hono/zod-validator` path-param validation.
  - `src/server/api/ollama.ts` — the GET health route.
  - `src/server/auth/invalid-grant.ts` — extracted from three duplicate definitions (`api/messages.ts`, `api/dev.ts`, `auth/session.ts`).
  - `src/server/auth/preconditions.ts` — `requireConnectedAccount` extracted from two duplicate inline blocks.
  - `src/server/gmail/client.ts` — added `getAttachment(messageId, attachmentId)`; existing `getMessage` is now also called with `format='full'` from the orchestrator.
  - `src/server/config.ts` — three new fields (`ollamaUrl`, `ollamaModel`, `ollamaTimeoutMs`).
  - `src/server/app.ts` — wired `registerClassifyRoutes` and `registerOllamaRoutes`.
  - `src/client/types.ts` — five new types (`ClassificationVerdict`, `ClassificationConfidence`, `ClassificationArtifact`, `ClassificationResult`, `OllamaHealth`).
- **Other:**
  - `package.json` / `package-lock.json` — five new runtime deps (`zod ^3.25.76`, `@hono/zod-validator ^0.4.3`, `pdfjs-dist ^4.10.38`, `@napi-rs/canvas ^0.1.100`, `node-html-parser ^7.1.0`).
  - `.env.example` — three new commented sections (`OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_TIMEOUT_MS`).
  - `tsconfig.server.json` — added `"DOM"` to `lib` for pdfjs-dist's `CanvasRenderingContext2D` cast at build time.

## ADRs introduced

- `docs/adr/004-server-side-pdf-rendering.md` — chose `pdfjs-dist` (legacy/Node build) + `@napi-rs/canvas` for server-side PDF→PNG rasterization, over poppler/mupdf-js/GraphicsMagick/Playwright. Documents the no-system-deps property, the native-binary risk, and the worker-bootstrap quirk.
- `docs/adr/005-classification-prompt-as-typescript-constant.md` — keep the system prompt as a `const SYSTEM_PROMPT = '...'` template literal in `src/server/classify/prompt.ts`. Documents the friction tradeoff (prompt edits are code changes), the no-runtime-mutation property, and the constraint imposed on Slice 014 / 015.
- `docs/adr/006-synchronous-classify-endpoint.md` — the per-message classify endpoint is a single synchronous HTTP POST with `OLLAMA_TIMEOUT_MS=120000`. Documents why SSE / polling / WebSocket / background-job / shorter-timeout-with-retry are all rejected for the one-message case (Slice 006's batch sync gets SSE separately).

## Test and smoke results

- **Test suite:** **43 test files, 382 tests, 0 failures** (`npx vitest run`, 23.03 s end-to-end). 122 new tests landed this slice — see the per-file breakdown in `plans/005-classify-one-email-end-to-end.md` § "Test run".
- **Smoke (server-side, the verifiable subset from the agent shell):**
  - `npm run build` exits 0 (after the `tsconfig.server.json` `DOM`-lib fix).
  - `npm run check:gmail-readonly` exits 0.
  - Production binary on `:3738` returns `200` from `/health`, `200` from `/api/accounts` (preserving the user's two real `accounts` rows), `200` from `/api/ollama/health` with `{reachable:false, ...}` in **0.04 s** when Ollama is unreachable (AC #8 — well inside the 5 s budget), and `404` from `/api/dev/enabled` (Slice 004 contract preserved through the new wiring).
  - Path-param validation: `400 invalid_params` on a non-numeric `:id`; `400 invalid_params` on a `:message_id` with disallowed characters; `404 account_not_found` on an unknown account.
  - **No-DB-write contract (AC #6):** before / after five POST `/classify` attempts the `processed_messages` row count stays at 10. The path that *would* hit Ollama / Gmail is precondition-gated by `requireConnectedAccount` (after a process restart wipes in-memory tokens), so the actual classify pipeline doesn't run in this smoke environment — the no-write property is verified at both the precondition gate and at the unit-test layer (`api/classify.test.ts` includes a dedicated count-before / count-after assertion on the happy path).
  - **Read-only Gmail discipline (AC #9):** `npm run check:gmail-readonly` OK after the `gmail/client.ts` extension; `grep` confirms only `gmail.readonly` + `userinfo.email` + `openid` scopes appear in non-test code; no Gmail-write method substring anywhere.
- **Browser-driven ACs deferred to human acceptance:** AC #1 (badge visual transitions), AC #2-#5 (real Gmail receipts → real verdict pills, PDF and HTML-body artifacts populate, Ollama-unreachable mid-classify chip, parse-error chip via debugging proxy). All pinned at the unit layer in `OllamaHealth.test.tsx`, `ClassifyRowAction.test.tsx`, `api/classify.test.ts`, `classify/index.test.ts`. Same shape as Slice 004's deferred-AC story.

## Code review notes

Findings from reviewing the diff against the spec and plan.

**Fixed during this spec**

- The `tsconfig.server.json` build error around `CanvasRenderingContext2D`. `pdfjs-dist`'s render API typings reference DOM's `CanvasRenderingContext2D` and the server tsconfig deliberately had `lib: ["ES2022"]`. Vitest didn't catch it (it has its own resolver / lib defaults) and `npm run typecheck` (root tsconfig with DOM in lib) didn't either. `npm run build` (production tsc with the server tsconfig) caught it during the smoke step. Fix: added `"DOM"` to the server tsconfig's `lib`, with an inline comment explaining the slice's specific need. Compile-time-only — Node's runtime still has no `window`/`document`. Worth knowing for any future server code that touches a fundamentally browser-shaped library.
- The ESM-identity gotcha in `api/classify.test.ts`. `vi.resetModules()` (necessary for resetting the server-side DB singleton in `beforeEach`) re-evaluates `'../classify/ollama.js'` when the handler imports it transitively, giving the orchestrator's `OllamaUnreachableError` a different class identity than the test file's top-level import. Result: `err instanceof OllamaUnreachableError` was false at the handler, mis-mapping the error to the catch-all `gmail_error` 502. Fix: re-import the error classes after `vi.resetModules()` in `beforeEach` (`ollamaErrors = await import('../classify/ollama.js')`) and `throw new ollamaErrors.OllamaUnreachableError(...)` in the test bodies. Documented inline in `classify.test.ts` as a comment for future contributors who hit the same trap.
- The `vi.fn(async () => ...)` typing pattern. The implicit return type infers as zero-arg, which makes `mock.calls[X]?.[Y]` a `tsc --noEmit` error in TypeScript 5.7 strict mode. Vitest itself doesn't enforce TS strictness so the runtime path passes; only `npm run typecheck` catches it. Came up four times this slice (`messages.test.ts` and `dev.test.ts` test fakes after the `getAttachment` extension; `ollama.test.ts` chat mock; `classify/index.test.ts` chat mock; `api/classify.test.ts` classifyMessage mock; `api/ollama.test.ts` listModels mock). Each fixed with an explicit type alias passed to `vi.fn<Fn>(...)`. Could be a shared util in test-setup but premature.
- A third inline copy of `isInvalidGrantError` in `src/server/auth/session.ts` (line 97) that the research / plan both missed. Caught during step 4's grep; folded into the same step rather than spawning a follow-up. The session.ts callsite is the token-refresh failure path; behavior is unchanged. Net: three duplicates → one canonical home.
- The `OllamaParseError` ended up living in `src/server/classify/ollama.ts` (alongside `OllamaUnreachableError` and `OllamaHttpError`) rather than in a separate `errors.ts`. The plan's step 12 done-log tentatively suggested keeping it next to the orchestrator's JSON.parse / Zod call; revised in step 13 because the orchestrator already imports from `ollama.ts` for the `chat` function — adding one more class to that module doesn't grow the import surface.

**Followups for later**

- **`tsconfig.server.json`'s `DOM` lib add is a small surface increase.** Future server code could accidentally reach for `window` / `document` and the typechecker won't object. The build wouldn't break (Node still doesn't have those globals at runtime — the call would crash); a runtime crash is worse than a build break. Could be addressed by pinning `lib: ["ES2022"]` and using an ambient declaration for just `CanvasRenderingContext2D`, or by writing a structural type alias derived from pdfjs-dist's `RenderParameters['canvasContext']`. Not blocking; revisit if it becomes a real maintenance issue.
- **The fixture PDF is 13.6 KB**, exceeding the plan's "≤ 5 KB" target. Skia/PDF font embedding adds ~10 KB; trimming would require a more elaborate generator (subsetting fonts, picking lighter encoding). The fixture's bytes don't materially affect repo size or test time. Worth knowing but not worth fixing.
- **Gmail wrapper's test-seam pattern.** `setGmailFactoryForTest` / `resetGmailFactoryForTest` is module-level state. Slice 004's review queued a "promote to deps-object pattern" follow-up; this slice didn't address it. The new `getAttachment` reuses the same factory; consolidating would touch the existing test file and isn't worth doing alone.
- **Per-attempt persistence of extracted fields (Slice 014 territory).** Documented in the spec's "Out of scope" already.
- **Concurrency limit on the classify endpoint.** Multiple simultaneous Classify clicks would spawn parallel Ollama calls and fight for the host's GPU. ADR-006 calls this out; the architecture (Slice 006 onward) documents that account-level work serializes through Ollama. The per-message endpoint doesn't enforce a limit because there's only one user clicking the buttons at once on a localhost-only single-user tool. If it ever becomes a real issue, a small in-process semaphore over the orchestrator is the obvious shape.
- **Vitest fake-mocks library helper.** The `vi.fn<Fn>(...)` typing pattern recurred enough times this slice that a tiny `makeFetchMock<Fn>()` / `makeAsyncMock<Fn>()` helper in `test-setup.ts` could pay for itself. Premature for now; revisit if Slice 006+ keeps adding mocks.
- **`fetchMock` style mix in `Dashboard.test.tsx` is now four URL-routed `mockImplementation` cases plus one `mockResolvedValueOnce` case, with the `beforeEach` fall-through carrying both `/api/dev/enabled` and `/api/ollama/health`.** Slice 004's review flagged the mixing as a follow-up; it persists through this slice. The fall-through map will keep growing as new slices add background polls; eventually a `setupRoutedFetch({})` helper makes sense.
- **No CI-time prompt-eval harness.** Tuning the system prompt today means a code change + a smoke flow against real receipts. ADR-005 names this as out of scope; flag as Slice 016+ if classification quality regressions become a real issue.
- **The Ollama HTTP client is single-purpose.** It exposes only `chat` and `listModels` because that's all this slice needs. Slice 014's reclassification will reuse `chat` as-is; if a future spec needs `pull` / `delete` / `copy` model management, those grow the same file or move to a sibling module.

## Decisions worth flagging

- **`ollama_http_error` 502 mapping.** The spec explicitly maps `ollama_unreachable` (503) and `ollama_parse_error` (502); it does not enumerate "Ollama-reachable but returned non-2xx HTTP" (e.g. model crashed mid-request, Ollama returned 500). I chose a third error code, `ollama_http_error`, mapped to 502 with `{ status, body }` for debuggability — the alternatives (folding into `ollama_unreachable` because the call effectively failed; folding into `ollama_parse_error` because there's nothing to parse) both misdescribe what happened. The handler's `instanceof OllamaHttpError` branch is unit-tested in `api/classify.test.ts`. Listed as a deviation below.
- **Path-param validation error shape.** `@hono/zod-validator`'s default error envelope is `{ success: false, error: ... }`, which does not match the rest of the API's `{ error: 'kebab-case-code' }` convention. I added a custom hook that normalizes the shape to `{ error: 'invalid_params' }` with HTTP 400. Trade-off: less detail in the error body for the consumer (no field-level explanation), but consistent with how `messages.ts` and `dev.ts` shape their 400 responses. Path-param errors should be unreachable from the typed UI (the client builds URLs from `account.id` numbers and `message.id` strings); the response shape mostly matters for direct API users / debugging.
- **Component placement in Dashboard.** The spec said "shown in the Dashboard header"; the Dashboard has no distinct header element today. I placed `<OllamaHealth />` as the first child of `<main>` after the alert paragraph and before the AccountList — closest match in spirit. The two existing children (AccountList + AddAccountButton + DevSeedPanel) keep their order.
- **Image attachments passed through unchanged, not re-encoded to PNG.** The spec mentions "JPEG/PNG/GIF → PNG so the prompt builder has one consistent format"; I let JPEG / GIF / WebP through as their original bytes (base64-encoded) because Ollama's vision pipeline handles them transparently. Re-encoding to PNG would add CPU + memory cost for no functional benefit. The PDF path still rasterizes to PNG because the renderer's output is PNG.
- **`buildClassificationMessages` returns a `{ system, user }` object, not the full Ollama wire format.** The orchestrator unpacks the return into the two-message array Ollama expects. Trade-off: cleaner test surface (the prompt builder doesn't depend on `OllamaMessage`), at the cost of two lines of orchestrator wiring. Pinned by both `prompt.test.ts` and `classify/index.test.ts`.
- **`extractBodyText` returns `{ text: '' }` when no body is present, instead of throwing.** Encrypted / signed / pathological MIME shapes can land here; falling through silently lets the orchestrator still call Ollama with metadata + attachment images, which is the right answer for a multimodal classifier.
- **Orchestrator skips the body artifact when `body.text === ''`.** A receipt that's purely an attachment with an empty body produces `artifacts: [{ kind: 'attachment', ... }]` only. Matches the spec's "the artifacts array lists what was sent to the model".
- **`MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024` and `MAX_PDF_PAGES = 5` exported from the orchestrator.** Spec values; exported so Slice 006's batch sync can import the same constants. No env-var override yet; all-codebase-tunable for v1.
- **30 s polling cadence for `OllamaHealth`.** Spec value; hard-coded in the component as `POLL_INTERVAL_MS = 30_000`. No env-var override; tuning is a code change.
- **`HEALTH_TIMEOUT_MS = 5000` for the health route, distinct from `OLLAMA_TIMEOUT_MS`.** Spec AC #8 requires the health endpoint to return within ~5 s even when Ollama is unreachable. Threading the slice's main `OLLAMA_TIMEOUT_MS` through the health probe would gate it on 120 s — wrong. Two timeout constants is the right shape. AC verified at 0.04 s during smoke.
- **Endpoint always returns 200, never non-2xx.** The badge needs a structured payload regardless of the underlying state; the `reachable` field carries the failure signal. The component branches on the body, not the status.
- **The `parse_error` chip's raw response is shown in a `<details>` block.** The user can expand it for debugging without it dominating the row UI. Reads well at small scale; not all Ollama-malformed responses are short.

## Deviations from spec or architecture

- **`ollama_http_error` is a new error code the spec did not enumerate.** Mapped to 502 with `{ error: 'ollama_http_error', status, body }` for debuggability. Justification under "Decisions worth flagging" above. Pinned by `api/classify.test.ts` and `client/components/ClassifyRowAction.test.tsx`.
- **Image attachments are passed through unchanged rather than re-encoded to PNG.** The spec's prose says "render images to PNG"; my implementation skips the re-encode for `image/{png,jpeg,gif,webp}` and relies on Ollama's vision pipeline to accept them natively. Output to the model is unchanged in semantic — the model sees the image bytes. Justification under "Decisions worth flagging" above. The PDF path still rasterizes to PNG.
- **`tsconfig.server.json` `lib` extended with `DOM`.** The spec's deliverables list does not include this change. Required for the server build to type-check `pdfjs-dist`'s render-parameter cast. Explained in "Code review notes" above.
- **Smoke recipe.** AC #2-#5 and the spec's "stop Ollama, click Classify" flow require a real browser, real Gmail tokens, real receipt corpus, and a reachable Ollama instance. The agent's network has none of those. The smoke run verified everything from `/health` through the path-param validation and the no-DB-write contract using the production binary on a test port; the browser-driven ACs are pinned at the unit layer and deferred to human acceptance. Same shape as Slice 004's review.
- **No deviations from `architecture.md` § "Read-only Gmail access", § "Privacy model", or § "Components — Classification module" steps 1-5.** The slice realizes the architecture's classification-module narrative end-to-end as the spec called out. The architecture's step-6 persistence is correctly out of scope (Slice 006).
