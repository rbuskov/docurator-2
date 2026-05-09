import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app.js'

describe('createApp', () => {
  it('responds to GET /health with 200 and body "ok"', async () => {
    const app = createApp()
    const res = await app.fetch(new Request('http://localhost/health'))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })
})

describe('static fallback', () => {
  let staticDir: string

  beforeEach(() => {
    staticDir = mkdtempSync(join(tmpdir(), 'docurator-static-'))
    writeFileSync(
      join(staticDir, 'index.html'),
      '<!doctype html><html><head><title>Docurator</title></head><body><div id="root"></div></body></html>',
    )
  })

  afterEach(() => {
    rmSync(staticDir, { recursive: true, force: true })
  })

  it('serves index.html for GET / when staticDir is provided', async () => {
    const app = createApp({ staticDir })
    const res = await app.fetch(new Request('http://localhost/'))
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Docurator')
  })

  it('keeps /health winning over the static fallback', async () => {
    const app = createApp({ staticDir })
    const res = await app.fetch(new Request('http://localhost/health'))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })
})
