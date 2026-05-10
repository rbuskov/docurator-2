import { chromium } from 'playwright'

// Renders an HTML string to a single-page-or-multi-page A4 PDF via headless
// Chromium. Used by the sync orchestrator when the receipt is the email
// body itself (no PDF attachment to dedupe against). Each call launches a
// fresh browser process and closes it in `finally`; the orchestrator's
// `MAX_CONCURRENT_CLASSIFY=1` default keeps that cost bounded.
//
// Architecture: cf. `architecture.md` § "Tech stack" (`HTML → PDF | Playwright
// headless | Robust render of receipt emails`). The classifier's
// `render-pdf.ts` (Slice 005) goes the other direction (PDF → page images
// for the vision model); this module is its mirror.
export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.setContent(html, { waitUntil: 'networkidle' })
    return await page.pdf({ format: 'A4', printBackground: true })
  } finally {
    await browser.close()
  }
}
