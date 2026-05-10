import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { renderPdfToImages } from './render-pdf.js'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const FIXTURE = readFileSync(join(moduleDir, '__fixtures__', 'sample.pdf'))
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('renderPdfToImages', () => {
  it('renders a 2-page PDF to two PNG buffers when maxPages >= page count', async () => {
    const buffers = await renderPdfToImages(new Uint8Array(FIXTURE), 5)
    expect(buffers).toHaveLength(2)
    for (const buf of buffers) {
      expect(buf.length).toBeGreaterThan(0)
      expect(buf.subarray(0, 8).equals(PNG_MAGIC)).toBe(true)
    }
  })

  it('caps output to maxPages even when the PDF has more pages', async () => {
    const buffers = await renderPdfToImages(new Uint8Array(FIXTURE), 1)
    expect(buffers).toHaveLength(1)
    expect(buffers[0]?.subarray(0, 8).equals(PNG_MAGIC)).toBe(true)
  })

  it('returns an empty array when maxPages is 0', async () => {
    const buffers = await renderPdfToImages(new Uint8Array(FIXTURE), 0)
    expect(buffers).toEqual([])
  })

  it('rejects when the input bytes are not a valid PDF', async () => {
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04])
    await expect(renderPdfToImages(garbage, 1)).rejects.toThrow()
  })
})
