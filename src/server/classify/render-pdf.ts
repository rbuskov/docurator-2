import { createRequire } from 'node:module'
import { createCanvas } from '@napi-rs/canvas'

// Renders a PDF to one PNG buffer per page, capped at `maxPages`. Pure
// transform — no I/O, no Gmail. Uses pdfjs-dist's legacy/Node build because
// the default `pdf.mjs` entry assumes a browser; the legacy build is the one
// that runs under Node without polyfills.
//
// `isEvalSupported: false` disables eval-based font handling (recommended for
// Node per pdfjs-dist docs). `useSystemFonts: false` keeps font lookups
// hermetic. The worker bundle's resolved path is set on
// `GlobalWorkerOptions.workerSrc` once per process — pdfjs-dist refuses to
// boot without one even on the main thread.
const RENDER_SCALE = 1.5

const requireFromHere = createRequire(import.meta.url)
const WORKER_SRC = requireFromHere.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')

export async function renderPdfToImages(
  pdfBytes: Uint8Array,
  maxPages: number,
): Promise<Buffer[]> {
  if (maxPages <= 0) return []

  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')
  if (pdfjsLib.GlobalWorkerOptions && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = WORKER_SRC
  }

  const doc = await pdfjsLib.getDocument({
    data: pdfBytes,
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise

  const pageCount = Math.min(doc.numPages, maxPages)
  const out: Buffer[] = []
  for (let i = 1; i <= pageCount; i++) {
    const page = await doc.getPage(i)
    const viewport = page.getViewport({ scale: RENDER_SCALE })
    const width = Math.ceil(viewport.width)
    const height = Math.ceil(viewport.height)
    const canvas = createCanvas(width, height)
    const ctx = canvas.getContext('2d')
    // Fill white so transparent PDFs render against a white background instead
    // of bleeding through as black (vision models occasionally misread the
    // latter).
    ctx.fillStyle = 'white'
    ctx.fillRect(0, 0, width, height)
    await page.render({
      // pdfjs-dist's CanvasRenderingContext2D type comes from its own
      // canvas-types module; @napi-rs/canvas's context is API-compatible at
      // runtime but nominally distinct, so we widen via unknown.
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise
    out.push(canvas.toBuffer('image/png'))
  }
  await doc.destroy()
  return out
}
