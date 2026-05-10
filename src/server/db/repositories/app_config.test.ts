import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const migrationsDir = join(moduleDir, '..', 'migrations')

describe('app_config repository', () => {
  let tempDir: string
  let appConfig: typeof import('./app_config.js')
  let dbModule: typeof import('../index.js')

  beforeEach(async () => {
    vi.resetModules()
    tempDir = mkdtempSync(join(tmpdir(), 'docurator-app-config-'))

    dbModule = await import('../index.js')
    dbModule.setDbPathForTest(join(tempDir, 'test.db'))

    const { migrate } = await import('../migrate.js')
    migrate(dbModule.getDb(), migrationsDir)

    appConfig = await import('./app_config.js')
  })

  afterEach(() => {
    try {
      dbModule.getDb().close()
    } catch {
      // already closed
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('get returns the seeded singleton row after migration', () => {
    expect(appConfig.get()).toEqual({ id: 1, fiscal_year_start_month: 1 })
  })

  it('update changes fiscal_year_start_month and is observable via get', () => {
    appConfig.update({ fiscal_year_start_month: 7 })
    expect(appConfig.get()).toEqual({ id: 1, fiscal_year_start_month: 7 })
  })

  it('update throws when fiscal_year_start_month is above the CHECK range', () => {
    expect(() => appConfig.update({ fiscal_year_start_month: 13 })).toThrow(/CHECK/)
  })

  it('update throws when fiscal_year_start_month is below the CHECK range', () => {
    expect(() => appConfig.update({ fiscal_year_start_month: 0 })).toThrow(/CHECK/)
  })

  it('update with an empty partial is a no-op', () => {
    appConfig.update({})
    expect(appConfig.get()).toEqual({ id: 1, fiscal_year_start_month: 1 })
  })

  it('get throws when the singleton row is missing', () => {
    dbModule.getDb().exec('DELETE FROM app_config')
    expect(() => appConfig.get()).toThrow(/app_config/)
  })
})
