import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const FORBIDDEN: readonly string[] = [
  'messages.modify',
  'messages.trash',
  'messages.delete',
  'messages.send',
  'messages.insert',
  'messages.import',
  'labels.create',
  'labels.delete',
  'labels.update',
  'labels.patch',
  'drafts.create',
  'drafts.update',
  'drafts.delete',
  'drafts.send',
  'threads.modify',
  'threads.trash',
  'threads.delete',
  'gmail.modify',
  'gmail.send',
  'gmail.compose',
  'gmail.insert',
  'gmail.metadata',
  'gmail.labels',
  'gmail.settings.basic',
  'gmail.settings.sharing',
]

const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx'])

export type Hit = { file: string; substring: string }

export function scanForForbidden(
  rootDir: string,
  selfPath?: string,
): { hits: Hit[] } {
  const hits: Hit[] = []
  const skipPath = selfPath !== undefined ? path.resolve(selfPath) : undefined

  const entries = readdirSync(rootDir, { recursive: true, withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const ext = path.extname(entry.name)
    if (!SCANNED_EXTENSIONS.has(ext)) continue
    const parentDir =
      typeof entry.parentPath === 'string' ? entry.parentPath : rootDir
    const absPath = path.resolve(parentDir, entry.name)
    if (skipPath !== undefined && absPath === skipPath) continue

    const content = readFileSync(absPath, 'utf8')
    for (const sub of FORBIDDEN) {
      if (content.includes(sub)) {
        hits.push({ file: absPath, substring: sub })
      }
    }
  }

  return { hits }
}

function isMain(): boolean {
  if (typeof process.argv[1] !== 'string') return false
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href
  } catch {
    return false
  }
}

if (isMain()) {
  const selfPath = fileURLToPath(import.meta.url)
  const root = path.resolve(process.cwd(), 'src')
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`check-gmail-readonly: src directory not found at ${root}`)
    process.exitCode = 1
  } else {
    const { hits } = scanForForbidden(root, selfPath)
    if (hits.length === 0) {
      console.log('OK: no forbidden Gmail-write substrings in src/')
    } else {
      for (const hit of hits) {
        console.error(
          `FAIL: ${path.relative(process.cwd(), hit.file)} contains forbidden substring "${hit.substring}"`,
        )
      }
      process.exitCode = 1
    }
  }
}
