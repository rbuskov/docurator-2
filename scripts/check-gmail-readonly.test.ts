import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scanForForbidden } from './check-gmail-readonly.js'

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'docurator-gmail-check-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

function writeFile(relPath: string, content: string): string {
  const abs = path.join(tempDir, relPath)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, content, 'utf8')
  return abs
}

describe('scanForForbidden', () => {
  it('returns no hits when only clean files exist', () => {
    writeFile('clean.ts', `export const x = 'gmail.readonly'\n`)
    writeFile('also-clean.tsx', `export const y = () => null\n`)
    expect(scanForForbidden(tempDir).hits).toEqual([])
  })

  it('reports a single hit with file path and substring', () => {
    writeFile('bad.ts', `// uses messages.modify here\n`)
    const { hits } = scanForForbidden(tempDir)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.file).toBe(path.join(tempDir, 'bad.ts'))
    expect(hits[0]?.substring).toBe('messages.modify')
  })

  it('reports each forbidden substring in a file with multiple hits', () => {
    writeFile(
      'bad.ts',
      `// uses messages.modify\nfunction f() { return 'drafts.create' }\n`,
    )
    const { hits } = scanForForbidden(tempDir)
    const subs = hits.map((h) => h.substring).sort()
    expect(subs).toEqual(['drafts.create', 'messages.modify'])
    expect(hits.every((h) => h.file === path.join(tempDir, 'bad.ts'))).toBe(true)
  })

  it('walks nested directories recursively', () => {
    writeFile('a/b/c/x.ts', `// gmail.send\n`)
    const { hits } = scanForForbidden(tempDir)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.file).toBe(path.join(tempDir, 'a/b/c/x.ts'))
    expect(hits[0]?.substring).toBe('gmail.send')
  })

  it('skips files matching the selfPath even when they contain forbidden substrings', () => {
    const selfPath = writeFile('check-gmail-readonly.ts', `// messages.modify\n`)
    writeFile('other.ts', `export const ok = true\n`)
    expect(scanForForbidden(tempDir, selfPath).hits).toEqual([])
  })

  it('includes .tsx, .js, .jsx files in the scan', () => {
    writeFile('a.tsx', `// drafts.send\n`)
    writeFile('b.js', `/* labels.delete */\n`)
    writeFile('c.jsx', `// threads.trash\n`)
    writeFile('d.md', `messages.modify in markdown should not be scanned\n`)
    const subs = scanForForbidden(tempDir).hits.map((h) => h.substring).sort()
    expect(subs).toEqual(['drafts.send', 'labels.delete', 'threads.trash'])
  })

  it('returns no hits for the real src/ tree (regression guard)', () => {
    const srcDir = path.resolve(import.meta.dirname, '..', 'src')
    expect(scanForForbidden(srcDir).hits).toEqual([])
  })
})
