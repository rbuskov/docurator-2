# ADR-004: Server-side PDF rendering via pdfjs-dist + @napi-rs/canvas

**Status:** Accepted
**Date:** 2026-05-09
**Supersedes:** —
**Spec:** `docs/specs/005-classify-one-email-end-to-end.md`

## Context

Slice 005 introduces the classification pipeline. One step in the pipeline (`docs/architecture.md` § "Components — Classification module", step 2) renders each PDF attachment to one image per page so the multimodal vision model can see the receipt's visual layout (line items, totals, vendor logos). The architecture pins `qwen2.5vl:7b` as the default model and a vision-capable interface as the contract; it does not name a server-side PDF→image library — `architecture.md` § "Tech stack" mentions `react-pdf` for *client-side* preview only.

The PDFs the pipeline encounters are real receipt and invoice attachments from arbitrary vendors. They include scanned PDFs (image-only), text PDFs with embedded fonts, multi-page contracts, password-stripped exports — everything Gmail can carry. The renderer must be:

1. **No system dependencies.** The dev shape is a Claude Code devcontainer (Slice 004's review covered the migration); the production shape is a Node container the user runs locally. Neither shape installs poppler, mupdf, ImageMagick, GraphicsMagick, or libreoffice. Adding a `Dockerfile` `apt-get install` for any of those expands the image surface and breaks the cross-platform parity the architecture cares about.
2. **Cross-platform.** The same code runs on the maintainer's macOS, Linux dev hosts, and Linux production containers without conditional setup.
3. **Single-process and synchronous-friendly.** The classify endpoint is a single HTTP handler; the renderer is called once per PDF attachment per request. No queue, no worker pool.
4. **Bounded.** A 5-page render of a single 5 MB PDF must fit in the Node process's heap without OOM. The spec caps PDF rendering at 5 pages for exactly this reason.

## Decision

Use **`pdfjs-dist` (legacy/Node build) + `@napi-rs/canvas`** for PDF→PNG rendering inside `src/server/classify/render-pdf.ts`.

The renderer imports `pdfjs-dist/legacy/build/pdf.mjs` (the Node-compatible build), opens the PDF via `getDocument({ data, isEvalSupported: false, useSystemFonts: false })`, and for each page up to `maxPages` rasterizes against an `@napi-rs/canvas` 2D context at 1.5× scale, writing the result as PNG via `canvas.toBuffer('image/png')`. `GlobalWorkerOptions.workerSrc` is set once per process to the resolved path of `pdfjs-dist/legacy/build/pdf.worker.mjs` — pdfjs-dist refuses to boot without one even on the main thread.

Both packages are pure-JS or use prebuilt native binaries shipped by the package itself; nothing on the host needs to be installed. `@napi-rs/canvas` ships binaries for `linux-{x64,arm64}-gnu`, `darwin-{x64,arm64}`, and `win32-x64-msvc` — every platform the project supports. `pdfjs-dist`'s Node entry runs without polyfills under Node 20+.

## Consequences

- **Zero system deps.** A `docker compose up` (or the devcontainer) brings a working renderer with no `apt-get` step. The same `npm ci && npm run build` works on macOS dev hosts, Linux containers, and any future GitHub Actions worker.
- **Image-size cost.** `@napi-rs/canvas`'s prebuilt binary is ~12 MB. `pdfjs-dist` is ~3 MB of JS. Net image-size addition is ~15-20 MB after deduplication — acceptable for a self-hosted single-user tool where image bloat is a quality-of-life issue, not a deployment cost.
- **Native-binary risk.** `@napi-rs/canvas`'s binary must match the runtime's libc (glibc vs musl) and architecture. The devcontainer is `linux-x64-gnu` (Debian-derived); supported. Apple-silicon hosts use the `darwin-arm64` build; supported. Alpine-based images would need the `musl` variant (currently undocumented for `@napi-rs/canvas`). Slice 005 does not target Alpine; if a future spec switches the production image, this constraint surfaces in the build break and the renderer can swap.
- **Worker setup is awkward.** pdfjs-dist refuses to render without `GlobalWorkerOptions.workerSrc` set to a real file path; the legacy build still spawns a fake worker on the main thread for orchestration. The renderer resolves the worker file via `createRequire(import.meta.url).resolve(...)` once at module load. The first invocation initializes; subsequent calls reuse. No worker process is actually spawned.
- **No incremental render.** `pdfjs-dist` renders a page to completion before returning; there's no streaming page-by-page output to the model. Acceptable for the 5-page cap.
- **Constraint imposed on later specs.** Other slices that need to render PDFs (e.g. Slice 011's export, if it embeds receipt previews) should reuse `renderPdfToImages` rather than introducing a parallel renderer. Slice 006's HTML→PDF (Playwright) is a separate concern — Playwright produces PDFs from HTML, then this renderer can rasterize them if a vision model needs to see the result.
- **Heap pressure is bounded but real.** A 5-page PDF at 1.5× scale produces ~8.5 MP per page (612×792 pt at 1.5× = ~919×1188 px); each PNG buffer is ~1-3 MB depending on content density. Five pages × a few MB stays comfortably inside Node's default heap (`--max-old-space-size=4096` per the devcontainer; the production container default is 1.5 GB but the spec's cap of one classify-at-a-time keeps the working set small).
- **Test fixture is committed.** The 2-page PDF used by `render-pdf.test.ts` is generated by `src/server/classify/__fixtures__/generate-sample.ts` (committed alongside the fixture so the bytes are reproducible) and the resulting `sample.pdf` is checked in. Generating the fixture in a `beforeAll` would couple every test run to the generator's correctness; checking in the bytes treats the fixture as data.

## Alternatives considered

- **`poppler` / `pdftoppm` / `pdftocairo` (system-installed)** — fast, well-tested, used by every Linux desktop. Requires `apt-get install poppler-utils` in the Dockerfile (and the platform-specific equivalent for macOS / Windows dev). Adds ~30 MB to the image; breaks the no-system-deps property the architecture implicitly carries (no other slice has a `RUN apt-get`). Rejected for portability and surface area.
- **`mupdf-js` (WebAssembly)** — pure JS, no native binary, faster than `pdfjs-dist` on most workloads. The package is less mature than `pdfjs-dist`, has a smaller community, and its API surface is non-trivial. The marginal performance is wasted on 5-page renders that already complete in <1 s. Rejected as overkill.
- **`pdf-poppler` / `pdf2pic` (Node wrappers around system poppler)** — same system-dep cost as raw poppler, plus an extra abstraction layer that fails confusingly when the underlying binary is missing. Rejected.
- **GraphicsMagick / ImageMagick (`gm` Node wrapper)** — heavy dependency, system-installed, requires `imagemagick` and `ghostscript`. Renders any image format, but the architecture has no other use for it. Rejected for surface area.
- **Playwright (already a Slice 006 dep) for PDF→images** — Playwright's `page.goto('file://...pdf')` opens a browser-built PDF viewer; `page.screenshot` captures it. Adds Chromium (~150 MB) to the image and requires a browser launch per PDF. Slice 005 doesn't yet pull in Playwright; pulling it in here for one use case is premature when Slice 006's HTML→PDF need pulls it in honestly. Once Playwright lands in Slice 006 the question can be revisited, but `pdfjs-dist` remains the lighter renderer for raster output.
- **`@napi-rs/canvas`'s `loadPDF` (if it existed)** — would consolidate the two deps. It does not exist; `@napi-rs/canvas` is pure raster and doesn't parse PDFs. Mentioned only because it's an obvious question.
- **No PDF rendering — feed the PDF bytes directly to Ollama as an `application/pdf` attachment** — Ollama's chat API accepts images via the message-level `images` array but does not natively understand PDF input; the model receives base64 bytes it cannot interpret. Rejected as functionally broken.

## Supersession

—
