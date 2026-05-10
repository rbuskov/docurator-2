// One-shot generator for the test fixture used by render-pdf.test.ts.
// Re-run with `npx tsx src/server/classify/__fixtures__/generate-sample.ts`
// when the fixture needs regenerating. Produces a tiny 2-page PDF with a
// distinguishing string per page so the renderer's output can be eyeballed.
//
// Committed alongside the fixture so the bytes are reproducible — Slice 005's
// research/plan called out the choice not to add a runtime dep just to make
// the fixture; @napi-rs/canvas is already a runtime dep for this slice.
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument } from '@napi-rs/canvas'

const here = dirname(fileURLToPath(import.meta.url))

const doc = new PDFDocument({ title: 'Docurator test fixture' })

for (const [index, label] of ['Page 1 of fixture', 'Page 2 of fixture'].entries()) {
  const ctx = doc.beginPage(612, 792)
  ctx.fillStyle = 'white'
  ctx.fillRect(0, 0, 612, 792)
  ctx.fillStyle = 'black'
  ctx.font = 'bold 32px sans-serif'
  ctx.fillText(label, 100, 100 + index * 0)
  ctx.font = '16px sans-serif'
  ctx.fillText('Lorem ipsum dolor sit amet.', 100, 160)
  doc.endPage()
}

const buf = doc.close()
const out = join(here, 'sample.pdf')
writeFileSync(out, buf)
console.log(`Wrote ${out} (${buf.length} bytes)`)
