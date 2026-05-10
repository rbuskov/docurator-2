import type { OAuth2Client } from 'google-auth-library'
import { type gmail_v1, google } from 'googleapis'
import { withFreshTokens } from '../auth/session.js'

export type GmailFactory = (auth: OAuth2Client) => gmail_v1.Gmail

const defaultFactory: GmailFactory = (auth) => google.gmail({ version: 'v1', auth })

let gmailFactory: GmailFactory = defaultFactory

export function setGmailFactoryForTest(f: GmailFactory): void {
  gmailFactory = f
}

export function resetGmailFactoryForTest(): void {
  gmailFactory = defaultFactory
}

export type ListMessagesArgs = {
  maxResults: number
  q?: string
  pageToken?: string
}

export type ListMessagesResult = {
  messages: Array<{ id?: string | null; threadId?: string | null }>
  nextPageToken?: string | null
  resultSizeEstimate?: number | null
}

export type GetMessageArgs = {
  format: 'minimal' | 'full' | 'raw' | 'metadata'
  metadataHeaders?: string[]
}

export type AttachmentResult = {
  data: Buffer
  size: number
}

// snake_case input shape matches how the spec describes the call surface; the
// internal call maps to gmail's camelCase request fields.
export type HistoryListArgs = {
  start_history_id: string
  history_types?: string[]
  page_token?: string
}

export type HistoryListResult = {
  history: gmail_v1.Schema$History[]
  history_id?: string | null
  next_page_token?: string | null
}

export type ProfileResult = {
  email_address: string | null
  history_id: string | null
  messages_total: number | null
  threads_total: number | null
}

export type GmailClient = {
  listMessages(args: ListMessagesArgs): Promise<ListMessagesResult>
  getMessage(id: string, args: GetMessageArgs): Promise<gmail_v1.Schema$Message>
  getAttachment(messageId: string, attachmentId: string): Promise<AttachmentResult>
  historyList(args: HistoryListArgs): Promise<HistoryListResult>
  getProfile(): Promise<ProfileResult>
}

export function createGmailClient(accountId: number): GmailClient {
  return {
    listMessages: (args) =>
      withFreshTokens(accountId, async (sessionClient) => {
        // session.SessionClientLike is a structural subset of OAuth2Client used
        // for testability. The runtime value is a real OAuth2Client; the cast
        // narrows it so googleapis accepts the auth handle.
        const gmail = gmailFactory(sessionClient as unknown as OAuth2Client)
        const res = await gmail.users.messages.list({
          userId: 'me',
          maxResults: args.maxResults,
          ...(args.q !== undefined ? { q: args.q } : {}),
          ...(args.pageToken !== undefined ? { pageToken: args.pageToken } : {}),
        })
        return {
          messages: res.data.messages ?? [],
          nextPageToken: res.data.nextPageToken,
          resultSizeEstimate: res.data.resultSizeEstimate,
        }
      }),

    getMessage: (id, args) =>
      withFreshTokens(accountId, async (sessionClient) => {
        const gmail = gmailFactory(sessionClient as unknown as OAuth2Client)
        const res = await gmail.users.messages.get({
          userId: 'me',
          id,
          format: args.format,
          ...(args.metadataHeaders !== undefined
            ? { metadataHeaders: args.metadataHeaders }
            : {}),
        })
        return res.data
      }),

    getAttachment: (messageId, attachmentId) =>
      withFreshTokens(accountId, async (sessionClient) => {
        const gmail = gmailFactory(sessionClient as unknown as OAuth2Client)
        const res = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId,
          id: attachmentId,
        })
        // Gmail's API returns base64url-encoded bytes in `data` plus a numeric
        // `size`. Buffer.from(..., 'base64url') handles the URL-safe alphabet
        // and missing padding without manual normalization.
        const raw = typeof res.data.data === 'string' ? res.data.data : ''
        return {
          data: Buffer.from(raw, 'base64url'),
          size: typeof res.data.size === 'number' ? res.data.size : 0,
        }
      }),

    historyList: (args) =>
      withFreshTokens(accountId, async (sessionClient) => {
        const gmail = gmailFactory(sessionClient as unknown as OAuth2Client)
        const res = await gmail.users.history.list({
          userId: 'me',
          startHistoryId: args.start_history_id,
          ...(args.history_types !== undefined ? { historyTypes: args.history_types } : {}),
          ...(args.page_token !== undefined ? { pageToken: args.page_token } : {}),
        })
        return {
          history: res.data.history ?? [],
          history_id: res.data.historyId,
          next_page_token: res.data.nextPageToken,
        }
      }),

    getProfile: () =>
      withFreshTokens(accountId, async (sessionClient) => {
        const gmail = gmailFactory(sessionClient as unknown as OAuth2Client)
        const res = await gmail.users.getProfile({ userId: 'me' })
        return {
          email_address: res.data.emailAddress ?? null,
          history_id: res.data.historyId ?? null,
          messages_total: res.data.messagesTotal ?? null,
          threads_total: res.data.threadsTotal ?? null,
        }
      }),
  }
}
