import { describe, expect, it } from 'vitest'
import { renderHtmlToPdf } from './render-html-pdf.js'

describe('renderHtmlToPdf', () => {
  it('produces a real PDF buffer (starts with %PDF magic)', async () => {
    const pdf = await renderHtmlToPdf(
      `<!doctype html><html><body><h1>Receipt</h1><p>Total: $9.99</p></body></html>`,
    )
    expect(Buffer.isBuffer(pdf)).toBe(true)
    expect(pdf.subarray(0, 5).toString('utf8')).toBe('%PDF-')
    expect(pdf.length).toBeGreaterThan(1024)
  })

  it('renders a body with inline CSS without throwing', async () => {
    const html = `
      <!doctype html>
      <html>
        <head><style>body { font-family: sans-serif; } .total { font-weight: bold; }</style></head>
        <body><div class="total">€42,50</div></body>
      </html>
    `
    const pdf = await renderHtmlToPdf(html)
    expect(pdf.subarray(0, 5).toString('utf8')).toBe('%PDF-')
  })

  it('handles minimal HTML without <html>/<body>', async () => {
    const pdf = await renderHtmlToPdf(`Hello receipt`)
    expect(pdf.subarray(0, 5).toString('utf8')).toBe('%PDF-')
  })
})
