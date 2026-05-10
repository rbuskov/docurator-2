import type { Hono } from 'hono'
import * as accounts from '../auth/accounts.js'
import * as session from '../auth/session.js'
import { config } from '../config.js'
import { getDb } from '../db/index.js'
import * as processedMessages from '../db/repositories/processed_messages.js'
import { createGmailClient as defaultCreateGmailClient } from '../gmail/client.js'
import type { GmailClient } from '../gmail/client.js'
import { extractHeader, parseFromAddressDomain } from '../gmail/headers.js'

const MAX_SEED_COUNT = 10

export type DevRouteDeps = {
  createGmailClient?: (accountId: number) => GmailClient
}

export function registerDevRoutes(app: Hono, deps: DevRouteDeps = {}): void {
  const _createGmailClient = deps.createGmailClient ?? defaultCreateGmailClient

  app.get('/api/dev/enabled', (c) => {
    if (config.nodeEnv === 'production') {
      return c.json({ error: 'not_found' }, 404)
    }
    return c.json({ enabled: true })
  })

  app.post('/api/dev/processed-messages/seed', async (c) => {
    if (config.nodeEnv === 'production') {
      return c.json({ error: 'not_found' }, 404)
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_body', detail: 'JSON parse failed' }, 400)
    }

    if (typeof body !== 'object' || body === null) {
      return c.json({ error: 'invalid_body', detail: 'expected object' }, 400)
    }
    const input = body as { account_id?: unknown; count?: unknown }

    const accountId = input.account_id
    if (
      typeof accountId !== 'number' ||
      !Number.isInteger(accountId) ||
      accountId <= 0
    ) {
      return c.json(
        { error: 'invalid_body', detail: 'account_id must be a positive integer' },
        400,
      )
    }

    const count = input.count
    if (
      typeof count !== 'number' ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > MAX_SEED_COUNT
    ) {
      return c.json(
        { error: 'invalid_body', detail: `count must be an integer in [1, ${MAX_SEED_COUNT}]` },
        400,
      )
    }

    const account = accounts.findById(accountId)
    if (account === undefined) {
      return c.json({ error: 'account_not_found' }, 404)
    }
    if (account.status !== 'connected') {
      return c.json(
        { error: 'account_not_connected', status: account.status },
        409,
      )
    }
    if (session.get(accountId) === undefined) {
      accounts.updateStatus(accountId, 'needs_reauth')
      return c.json({ error: 'account_not_connected', status: 'needs_reauth' }, 409)
    }

    const client = _createGmailClient(accountId)

    type StagedRow = {
      message_id: string
      thread_id: string
      internal_date: string
      subject: string | null
      sender_domain: string | null
    }
    const staged: StagedRow[] = []

    try {
      const list = await client.listMessages({ maxResults: count })
      for (const m of list.messages) {
        if (typeof m.id !== 'string') continue
        const message = await client.getMessage(m.id, {
          format: 'metadata',
          metadataHeaders: ['Subject', 'From'],
        })
        const subject = extractHeader(message, 'Subject') || null
        const fromHeader = extractHeader(message, 'From')
        const senderDomain = parseFromAddressDomain(fromHeader)
        staged.push({
          message_id: m.id,
          thread_id: m.threadId ?? '',
          internal_date: message.internalDate ?? '',
          subject,
          sender_domain: senderDomain,
        })
      }
    } catch (err) {
      if (isInvalidGrantError(err)) {
        return c.json({ error: 'needs_reauth', account_id: accountId }, 401)
      }
      const message = err instanceof Error ? err.message : 'Gmail call failed'
      return c.json({ error: 'gmail_error', message }, 502)
    }

    let inserted = 0
    let skipped = 0
    const processedAt = new Date().toISOString()
    const tx = getDb().transaction(() => {
      for (const row of staged) {
        if (
          processedMessages.existsForMessage({
            account_id: accountId,
            message_id: row.message_id,
          })
        ) {
          skipped += 1
          continue
        }
        processedMessages.insert({
          account_id: accountId,
          message_id: row.message_id,
          thread_id: row.thread_id,
          internal_date: row.internal_date,
          processed_at: processedAt,
          model_used: 'dev-seed',
          status: 'success',
          error_message: null,
          classification: 'other',
          confidence: 'low',
          reason: 'inserted by dev seed button',
          sender_domain: row.sender_domain,
          subject: row.subject,
        })
        inserted += 1
      }
    })
    tx()

    return c.json({ inserted, skipped })
  })
}

function isInvalidGrantError(err: unknown): boolean {
  if (err instanceof Error && err.message.includes('invalid_grant')) return true
  if (typeof err === 'object' && err !== null) {
    const e = err as { response?: { data?: { error?: string } } }
    if (e.response?.data?.error === 'invalid_grant') return true
  }
  return false
}
