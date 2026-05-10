import { createHash, randomUUID } from 'node:crypto'
import * as accountsRepo from '../auth/accounts.js'
import { isInvalidGrantError } from '../auth/invalid-grant.js'
import { classifyMessage as defaultClassifyMessage } from '../classify/index.js'
import type { ClassifyMessageArgs, ClassifyMessageDeps, ClassifyResult } from '../classify/index.js'
import { renderHtmlToPdf as defaultRenderHtmlToPdf } from '../classify/render-html-pdf.js'
import { config } from '../config.js'
import * as documentsRepo from '../db/repositories/documents.js'
import * as processedMessages from '../db/repositories/processed_messages.js'
import * as syncStateRepo from '../db/repositories/sync_state.js'
import {
  writeReceiptFile as defaultWriteReceiptFile,
  type WriteReceiptFileArgs,
  type WriteReceiptFileResult,
} from '../files.js'
import {
  createGmailClient as defaultCreateGmailClient,
  type GmailClient,
} from '../gmail/client.js'
import { chooseDiscovery } from './discovery.js'
import { syncEvents } from './events.js'

// See `docs/adr/008-in-memory-single-job-mutex.md`.
let activeJob: { job_id: string; started_at: string } | null = null

export class SyncInProgressError extends Error {
  readonly job_id: string
  constructor(job_id: string) {
    super(`sync_in_progress: ${job_id}`)
    this.job_id = job_id
    this.name = 'SyncInProgressError'
  }
}

export type RunSyncArgs = {
  account_ids?: number[]
  // ISO date `YYYY-MM-DD`. When set, this overrides each account's
  // `last_history_id` and forces a range search.
  since?: string
}

export type ClassifyMessageFn = (
  args: ClassifyMessageArgs,
  deps: ClassifyMessageDeps,
) => Promise<ClassifyResult>

export type WriteReceiptFileFn = (args: WriteReceiptFileArgs) => WriteReceiptFileResult

export type OrchestratorDeps = {
  createGmailClient?: (accountId: number) => GmailClient
  classifyMessage?: ClassifyMessageFn
  renderHtmlToPdf?: (html: string) => Promise<Buffer>
  writeReceiptFile?: WriteReceiptFileFn
  now?: () => Date
  uuid?: () => string
}

export type RunSyncResult = {
  job_id: string
  started_at: string
  done: Promise<void>
}

export function getActiveJob(): { job_id: string; started_at: string } | null {
  return activeJob
}

export function __resetActiveJobForTest(): void {
  activeJob = null
}

export function __setActiveJobForTest(job: { job_id: string; started_at: string } | null): void {
  activeJob = job
}

export async function runSync(
  args: RunSyncArgs,
  deps: OrchestratorDeps = {},
): Promise<RunSyncResult> {
  if (activeJob !== null) {
    throw new SyncInProgressError(activeJob.job_id)
  }

  const _classifyMessage = deps.classifyMessage ?? defaultClassifyMessage
  const _createGmailClient = deps.createGmailClient ?? defaultCreateGmailClient
  const _writeReceiptFile = deps.writeReceiptFile ?? defaultWriteReceiptFile
  const _renderHtmlToPdf = deps.renderHtmlToPdf ?? defaultRenderHtmlToPdf
  const _now = deps.now ?? (() => new Date())
  const _uuid = deps.uuid ?? randomUUID

  const job_id = _uuid()
  const started_at = _now().toISOString()
  activeJob = { job_id, started_at }

  const all = accountsRepo.list()
  const filterIds = args.account_ids
  const targets = all.filter(
    (a) =>
      (filterIds === undefined || filterIds.includes(a.id)) &&
      (a.status === 'connected' || a.status === 'needs_reauth'),
  )

  syncEvents.emit('sync.start', {
    job_id,
    account_ids: targets.map((t) => t.id),
    started_at,
  })

  const done = (async () => {
    try {
      for (const account of targets) {
        if (account.status !== 'connected') {
          syncEvents.emit('sync.error', {
            account_id: account.id,
            message: `account ${account.id} is in status ${account.status}; skipped`,
          })
          continue
        }

        syncEvents.emit('sync.account.start', { account_id: account.id })

        let processedCount = 0
        let receiptsCount = 0
        let failedCount = 0

        try {
          const messageIds = await discoverMessageIds({
            account_id: account.id,
            since: args.since,
            now: _now(),
            createGmailClient: _createGmailClient,
          })

          for (const message_id of messageIds) {
            const idempotencyHit = processedMessages.existsForMessage({
              account_id: account.id,
              message_id,
            })
            if (idempotencyHit) {
              // Skip — already processed in a prior run. Still emit a
              // sync.message so the UI can show "skipped" if it wants to.
              syncEvents.emit('sync.message', {
                account_id: account.id,
                message_id,
                status: 'skipped',
                document_ids: [],
              })
              continue
            }

            let result: ClassifyResult
            try {
              result = await classifyWithRetry({
                args: { account_id: account.id, message_id },
                deps: {
                  ollamaUrl: config.ollamaUrl,
                  ollamaModel: config.ollamaModel,
                  ollamaTimeoutMs: config.ollamaTimeoutMs,
                  createGmailClient: _createGmailClient,
                },
                classifyMessage: _classifyMessage,
              })
            } catch (err) {
              if (isInvalidGrantError(err)) {
                // `withFreshTokens` (Slice 002) already flipped the row to
                // needs_reauth as a side effect of the failing refresh; do it
                // again defensively in case the throw came from a path that
                // didn't go through the session helper.
                accountsRepo.updateStatus(account.id, 'needs_reauth')
                syncEvents.emit('sync.error', {
                  account_id: account.id,
                  message: 'invalid_grant — account flipped to needs_reauth',
                })
                // Stop processing this account; per-account isolation says
                // other accounts continue.
                break
              }
              const errorMessage = err instanceof Error ? err.message : 'classify failed'
              processedMessages.insert({
                account_id: account.id,
                message_id,
                thread_id: '',
                internal_date: String(_now().getTime()),
                processed_at: _now().toISOString(),
                model_used: config.ollamaModel,
                status: 'failed',
                error_message: errorMessage,
                classification: null,
                confidence: null,
                reason: null,
                sender_domain: null,
                subject: null,
              })
              processedCount += 1
              failedCount += 1
              syncEvents.emit('sync.message', {
                account_id: account.id,
                message_id,
                status: 'failed',
                error_message: errorMessage,
                document_ids: [],
              })
              continue
            }

            processedMessages.insert({
              account_id: account.id,
              message_id,
              thread_id: '',
              internal_date: String(_now().getTime()),
              processed_at: _now().toISOString(),
              model_used: result.model_used,
              status: 'success',
              error_message: null,
              classification: result.classification,
              confidence: result.confidence,
              reason: result.reason,
              sender_domain: null,
              subject: null,
            })
            processedCount += 1

            const documentIds: number[] = []
            const isReceipt =
              result.classification === 'receipt' || result.classification === 'invoice'
            if (isReceipt) {
              const persistResult = await persistArtifacts({
                account,
                message_id,
                result,
                writeReceiptFile: _writeReceiptFile,
                renderHtmlToPdf: _renderHtmlToPdf,
                now: _now(),
              })
              documentIds.push(...persistResult.document_ids)
              receiptsCount += 1
            }

            syncEvents.emit('sync.message', {
              account_id: account.id,
              message_id,
              status: 'success',
              classification: result.classification,
              confidence: result.confidence,
              document_ids: documentIds,
            })
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'account sync failed'
          syncEvents.emit('sync.error', { account_id: account.id, message })
        }

        // Refresh sync_state.last_history_id from Gmail's `getProfile`
        // regardless of how this account's loop terminated, *unless* the
        // account got flipped to needs_reauth mid-run — in that case the
        // tokens are dead and getProfile would just throw.
        const accountAfter = accountsRepo.findById(account.id)
        if (accountAfter?.status === 'connected') {
          await refreshSyncState({
            account_id: account.id,
            client: _createGmailClient(account.id),
            now: _now(),
          })
        }

        syncEvents.emit('sync.account.done', {
          account_id: account.id,
          processed: processedCount,
          receipts: receiptsCount,
          failed: failedCount,
        })
      }

      syncEvents.emit('sync.done', { job_id })
    } finally {
      activeJob = null
    }
  })()

  return { job_id, started_at, done }
}

// Per-message retry: one re-attempt on a generic transient error (Gmail 5xx,
// rate limit, network blip). `invalid_grant` is rethrown immediately because
// retrying a revoked token is pointless and the caller's needs_reauth-flip
// path is the right next step.
async function classifyWithRetry(args: {
  args: ClassifyMessageArgs
  deps: ClassifyMessageDeps
  classifyMessage: ClassifyMessageFn
}): Promise<ClassifyResult> {
  try {
    return await args.classifyMessage(args.args, args.deps)
  } catch (err) {
    if (isInvalidGrantError(err)) throw err
    return await args.classifyMessage(args.args, args.deps)
  }
}

async function discoverMessageIds(args: {
  account_id: number
  since: string | undefined
  now: Date
  createGmailClient: (accountId: number) => GmailClient
}): Promise<string[]> {
  const syncState = syncStateRepo.get(args.account_id)
  const decision = chooseDiscovery({
    syncState,
    since: args.since,
    fallbackDays: config.syncDefaultWindowDays,
    now: args.now,
  })

  const client = args.createGmailClient(args.account_id)

  if (decision.kind === 'history') {
    try {
      const ids = await collectHistoryMessageIds(client, decision.start_history_id)
      return ids
    } catch (err) {
      if (isHistory404(err)) {
        // Stale history id (Gmail expires history ~7 days). Fall back to a
        // range search using the same `fallbackDays` window the no-prior path
        // would use.
        const rangeDecision = chooseDiscovery({
          syncState: undefined,
          since: undefined,
          fallbackDays: config.syncDefaultWindowDays,
          now: args.now,
        })
        if (rangeDecision.kind !== 'range') {
          throw new Error('chooseDiscovery did not return a range fallback')
        }
        const list = await client.listMessages({ maxResults: 100, q: rangeDecision.q })
        return idsFromListMessages(list)
      }
      throw err
    }
  }

  const list = await client.listMessages({ maxResults: 100, q: decision.q })
  return idsFromListMessages(list)
}

function idsFromListMessages(list: {
  messages: Array<{ id?: string | null }>
}): string[] {
  return (list.messages ?? [])
    .map((m) => m.id ?? null)
    .filter((id): id is string => typeof id === 'string')
}

async function collectHistoryMessageIds(
  client: GmailClient,
  startHistoryId: string,
): Promise<string[]> {
  const seen = new Set<string>()
  let pageToken: string | undefined
  // Bound the page-walk to a generous-but-finite cap so a runaway history
  // response can't hang the orchestrator. 50 pages × 100 records ≈ enough.
  for (let page = 0; page < 50; page++) {
    const res = await client.historyList({
      start_history_id: startHistoryId,
      ...(pageToken !== undefined ? { page_token: pageToken } : {}),
    })
    for (const record of res.history ?? []) {
      // We care about messagesAdded only. labelsAdded / labelsRemoved /
      // messagesDeleted aren't relevant to "which receipts arrived since
      // last sync"; the latter two would only affect already-processed
      // messages that the user touched in Gmail.
      const added = (record as { messagesAdded?: Array<{ message?: { id?: string | null } }> })
        .messagesAdded
      for (const added_message of added ?? []) {
        const id = added_message.message?.id
        if (typeof id === 'string') seen.add(id)
      }
    }
    if (res.next_page_token === undefined || res.next_page_token === null) break
    pageToken = res.next_page_token
  }
  return [...seen]
}

function isHistory404(err: unknown): boolean {
  if (typeof err === 'object' && err !== null) {
    const e = err as { response?: { status?: number }; status?: number; code?: number }
    return e.response?.status === 404 || e.status === 404 || e.code === 404
  }
  return false
}

async function refreshSyncState(args: {
  account_id: number
  client: GmailClient
  now: Date
}): Promise<void> {
  // After a successful range or history sync, getProfile gives us the current
  // historyId so the next sync can run incrementally.
  try {
    const profile = await args.client.getProfile()
    syncStateRepo.upsert({
      account_id: args.account_id,
      last_history_id: profile.history_id ?? null,
      last_synced_at: args.now.toISOString(),
    })
  } catch {
    // Best-effort: a getProfile failure shouldn't fail the whole sync. Next
    // sync will just re-run as a range fallback.
  }
}

async function persistArtifacts(args: {
  account: { id: number; slug: string }
  message_id: string
  result: ClassifyResult
  writeReceiptFile: WriteReceiptFileFn
  renderHtmlToPdf: (html: string) => Promise<Buffer>
  now: Date
}): Promise<{ document_ids: number[] }> {
  const document_ids: number[] = []
  let seq = 0

  const attachmentArtifacts = args.result.artifacts.filter((a) => a.kind === 'attachment')

  for (const artifact of attachmentArtifacts) {
    if (artifact.filename === undefined) continue

    const bytes = args.result.source_bytes?.get(`attachment:${artifact.filename}`)
    if (bytes === undefined) continue

    const id = persistOne({
      account: args.account,
      message_id: args.message_id,
      seq,
      kind: 'attachment',
      mime_type: artifact.mime_type,
      filename: artifact.filename,
      bytes,
      result: args.result,
      now: args.now,
      writeReceiptFile: args.writeReceiptFile,
    })
    if (id !== undefined) document_ids.push(id)
    seq += 1
  }

  // Body-as-receipt: only persist the rendered body when *no* attachment
  // artifact exists. The "prefer attachment" rule from
  // architecture.md § "Deduplication strategy — Within-thread".
  const bodyArtifact = args.result.artifacts.find((a) => a.kind === 'body')
  if (attachmentArtifacts.length === 0 && bodyArtifact !== undefined) {
    const htmlBuf = args.result.source_bytes?.get('body:rendered_html_source')
    if (htmlBuf !== undefined) {
      const pdfBytes = await args.renderHtmlToPdf(htmlBuf.toString('utf8'))
      const id = persistOne({
        account: args.account,
        message_id: args.message_id,
        seq,
        kind: 'rendered_body',
        mime_type: 'application/pdf',
        filename: 'body.pdf',
        bytes: pdfBytes,
        result: args.result,
        now: args.now,
        writeReceiptFile: args.writeReceiptFile,
      })
      if (id !== undefined) document_ids.push(id)
      seq += 1
    }
  }

  return { document_ids }
}

function persistOne(args: {
  account: { id: number; slug: string }
  message_id: string
  seq: number
  kind: 'attachment' | 'rendered_body'
  mime_type: string
  filename: string
  bytes: Buffer
  result: ClassifyResult
  now: Date
  writeReceiptFile: WriteReceiptFileFn
}): number | undefined {
  // Hash from bytes first so dedup hits don't write the file at all.
  const content_hash = createHash('sha256').update(args.bytes).digest('hex')
  const existing = documentsRepo.findByHash({
    account_id: args.account.id,
    content_hash,
  })
  if (existing !== undefined) return existing.id

  const written = args.writeReceiptFile({
    account_slug: args.account.slug,
    internal_date: String(args.now.getTime()),
    message_id: args.message_id,
    seq: args.seq,
    suggested_filename: args.filename,
    bytes: args.bytes,
  })

  return documentsRepo.insert({
    account_id: args.account.id,
    message_id: args.message_id,
    kind: args.kind,
    filename: args.filename,
    mime_type: args.mime_type,
    size: written.size,
    content_hash: written.content_hash,
    file_path: written.file_path,
    vendor: args.result.vendor ?? null,
    amount: args.result.amount ?? null,
    currency: args.result.currency ?? null,
    transaction_date: args.result.transaction_date ?? null,
    created_at: args.now.toISOString(),
    updated_at: args.now.toISOString(),
  })
}
