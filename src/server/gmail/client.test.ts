import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as session from '../auth/session.js'
import {
  createGmailClient,
  resetGmailFactoryForTest,
  setGmailFactoryForTest,
} from './client.js'

type ListArgs = {
  userId: string
  maxResults?: number
  q?: string
  pageToken?: string
}

type GetArgs = {
  userId: string
  id: string
  format: string
  metadataHeaders?: string[]
}

type AttachmentArgs = {
  userId: string
  messageId: string
  id: string
}

type HistoryListArgs = {
  userId: string
  startHistoryId?: string
  historyTypes?: string[]
  pageToken?: string
}

type GetProfileArgs = {
  userId: string
}

type FakeGmail = {
  users: {
    messages: {
      list: ReturnType<typeof vi.fn>
      get: ReturnType<typeof vi.fn>
      attachments: {
        get: ReturnType<typeof vi.fn>
      }
    }
    history: {
      list: ReturnType<typeof vi.fn>
    }
    getProfile: ReturnType<typeof vi.fn>
  }
  __listCalls: ListArgs[]
  __getCalls: GetArgs[]
  __attachmentCalls: AttachmentArgs[]
  __historyCalls: HistoryListArgs[]
  __profileCalls: GetProfileArgs[]
}

function makeFakeGmail(opts: {
  listResponse?: unknown
  getResponse?: unknown
  listError?: Error
  getError?: Error
  attachmentResponse?: unknown
  attachmentError?: Error
  historyResponse?: unknown
  historyError?: Error
  profileResponse?: unknown
  profileError?: Error
}): FakeGmail {
  const listCalls: ListArgs[] = []
  const getCalls: GetArgs[] = []
  const attachmentCalls: AttachmentArgs[] = []
  const historyCalls: HistoryListArgs[] = []
  const profileCalls: GetProfileArgs[] = []
  const list = vi.fn(async (args: ListArgs) => {
    listCalls.push(args)
    if (opts.listError) throw opts.listError
    return { data: opts.listResponse ?? { messages: [] } }
  })
  const get = vi.fn(async (args: GetArgs) => {
    getCalls.push(args)
    if (opts.getError) throw opts.getError
    return { data: opts.getResponse ?? {} }
  })
  const attachmentGet = vi.fn(async (args: AttachmentArgs) => {
    attachmentCalls.push(args)
    if (opts.attachmentError) throw opts.attachmentError
    return { data: opts.attachmentResponse ?? {} }
  })
  const historyList = vi.fn(async (args: HistoryListArgs) => {
    historyCalls.push(args)
    if (opts.historyError) throw opts.historyError
    return { data: opts.historyResponse ?? {} }
  })
  const getProfile = vi.fn(async (args: GetProfileArgs) => {
    profileCalls.push(args)
    if (opts.profileError) throw opts.profileError
    return { data: opts.profileResponse ?? {} }
  })
  return {
    users: {
      messages: {
        list,
        get,
        attachments: { get: attachmentGet },
      },
      history: { list: historyList },
      getProfile,
    },
    __listCalls: listCalls,
    __getCalls: getCalls,
    __attachmentCalls: attachmentCalls,
    __historyCalls: historyCalls,
    __profileCalls: profileCalls,
  }
}

let withFreshTokensSpy: ReturnType<typeof makeSpy>

function makeSpy() {
  return vi
    .spyOn(session, 'withFreshTokens')
    .mockImplementation(async (_accountId, callback) => callback({} as never))
}

beforeEach(() => {
  withFreshTokensSpy = makeSpy()
})

afterEach(() => {
  withFreshTokensSpy.mockRestore()
  resetGmailFactoryForTest()
})

describe('createGmailClient.listMessages', () => {
  it('calls gmail.users.messages.list with userId="me" and the supplied maxResults', async () => {
    const fake = makeFakeGmail({
      listResponse: { messages: [{ id: 'a', threadId: 't1' }] },
    })
    setGmailFactoryForTest(() => fake as never)

    const client = createGmailClient(7)
    const result = await client.listMessages({ maxResults: 50 })

    expect(fake.users.messages.list).toHaveBeenCalledTimes(1)
    expect(fake.__listCalls[0]).toEqual({ userId: 'me', maxResults: 50 })
    expect(result.messages).toEqual([{ id: 'a', threadId: 't1' }])
  })

  it('normalizes a missing messages field to an empty array', async () => {
    const fake = makeFakeGmail({ listResponse: {} })
    setGmailFactoryForTest(() => fake as never)

    const client = createGmailClient(1)
    const result = await client.listMessages({ maxResults: 25 })

    expect(result.messages).toEqual([])
  })

  it('passes q and pageToken through when supplied', async () => {
    const fake = makeFakeGmail({})
    setGmailFactoryForTest(() => fake as never)

    const client = createGmailClient(2)
    await client.listMessages({ maxResults: 10, q: 'from:stripe', pageToken: 'tok' })

    expect(fake.__listCalls[0]).toEqual({
      userId: 'me',
      maxResults: 10,
      q: 'from:stripe',
      pageToken: 'tok',
    })
  })

  it('routes through session.withFreshTokens with the given accountId', async () => {
    const fake = makeFakeGmail({})
    setGmailFactoryForTest(() => fake as never)

    const client = createGmailClient(42)
    await client.listMessages({ maxResults: 5 })

    expect(withFreshTokensSpy).toHaveBeenCalledTimes(1)
    expect(withFreshTokensSpy.mock.calls[0]?.[0]).toBe(42)
  })

  it('rethrows session errors verbatim (no swallow, no rewrap)', async () => {
    const err = new Error('invalid_grant: token revoked')
    withFreshTokensSpy.mockImplementationOnce(async () => {
      throw err
    })

    const client = createGmailClient(3)
    await expect(client.listMessages({ maxResults: 50 })).rejects.toBe(err)
  })
})

describe('createGmailClient.getMessage', () => {
  it('calls gmail.users.messages.get with userId, id, format, and metadataHeaders', async () => {
    const payload = {
      id: 'msg1',
      threadId: 'thr1',
      internalDate: '1735689600000',
      payload: {
        headers: [
          { name: 'Subject', value: 'Hello' },
          { name: 'From', value: 'a@b.com' },
          { name: 'Date', value: 'Wed, 1 Jan 2025 00:00:00 +0000' },
        ],
      },
    }
    const fake = makeFakeGmail({ getResponse: payload })
    setGmailFactoryForTest(() => fake as never)

    const client = createGmailClient(1)
    const result = await client.getMessage('msg1', {
      format: 'metadata',
      metadataHeaders: ['Subject', 'From', 'Date'],
    })

    expect(fake.__getCalls[0]).toEqual({
      userId: 'me',
      id: 'msg1',
      format: 'metadata',
      metadataHeaders: ['Subject', 'From', 'Date'],
    })
    expect(result).toEqual(payload)
  })

  it('rethrows session errors verbatim', async () => {
    const err = new Error('invalid_grant: token revoked')
    withFreshTokensSpy.mockImplementationOnce(async () => {
      throw err
    })

    const client = createGmailClient(9)
    await expect(client.getMessage('msg1', { format: 'metadata' })).rejects.toBe(err)
  })
})

describe('createGmailClient.getAttachment', () => {
  it('calls gmail.users.messages.attachments.get with userId, messageId, and id', async () => {
    const fake = makeFakeGmail({
      attachmentResponse: { data: 'aGVsbG8', size: 5 },
    })
    setGmailFactoryForTest(() => fake as never)

    const client = createGmailClient(1)
    await client.getAttachment('msg1', 'att-1')

    expect(fake.users.messages.attachments.get).toHaveBeenCalledTimes(1)
    expect(fake.__attachmentCalls[0]).toEqual({
      userId: 'me',
      messageId: 'msg1',
      id: 'att-1',
    })
  })

  it('decodes base64url payload to a Buffer and exposes size', async () => {
    // 'aGVsbG8' is base64url for 'hello'.
    const fake = makeFakeGmail({
      attachmentResponse: { data: 'aGVsbG8', size: 5 },
    })
    setGmailFactoryForTest(() => fake as never)

    const client = createGmailClient(1)
    const result = await client.getAttachment('msg1', 'att-1')

    expect(Buffer.isBuffer(result.data)).toBe(true)
    expect(result.data.toString('utf8')).toBe('hello')
    expect(result.size).toBe(5)
  })

  it('decodes a base64url payload that uses the URL-safe alphabet (- and _)', async () => {
    // Build a payload with bytes that produce '-' and '_' in base64url.
    const bytes = Buffer.from([0xfb, 0xff, 0xbf])
    const payload = bytes.toString('base64url') // expect '-_-_' style
    expect(payload).toMatch(/[-_]/)
    const fake = makeFakeGmail({
      attachmentResponse: { data: payload, size: bytes.length },
    })
    setGmailFactoryForTest(() => fake as never)

    const client = createGmailClient(1)
    const result = await client.getAttachment('msg1', 'att-1')

    expect(result.data.equals(bytes)).toBe(true)
  })

  it('routes through session.withFreshTokens with the given accountId', async () => {
    const fake = makeFakeGmail({
      attachmentResponse: { data: 'aGVsbG8', size: 5 },
    })
    setGmailFactoryForTest(() => fake as never)

    const client = createGmailClient(99)
    await client.getAttachment('msg1', 'att-1')

    expect(withFreshTokensSpy).toHaveBeenCalledTimes(1)
    expect(withFreshTokensSpy.mock.calls[0]?.[0]).toBe(99)
  })

  it('rethrows session errors verbatim', async () => {
    const err = new Error('invalid_grant: token revoked')
    withFreshTokensSpy.mockImplementationOnce(async () => {
      throw err
    })

    const client = createGmailClient(3)
    await expect(client.getAttachment('msg1', 'att-1')).rejects.toBe(err)
  })

  it('rethrows API errors verbatim', async () => {
    const err = new Error('attachment not found')
    const fake = makeFakeGmail({ attachmentError: err })
    setGmailFactoryForTest(() => fake as never)

    const client = createGmailClient(1)
    await expect(client.getAttachment('msg1', 'att-1')).rejects.toBe(err)
  })
})

describe('createGmailClient.historyList', () => {
  it('calls gmail.users.history.list with userId="me" and startHistoryId', async () => {
    const fake = makeFakeGmail({
      historyResponse: { history: [], historyId: '123', nextPageToken: undefined },
    })
    setGmailFactoryForTest(() => fake as never)

    const client = createGmailClient(1)
    await client.historyList({ start_history_id: '100' })

    expect(fake.users.history.list).toHaveBeenCalledTimes(1)
    expect(fake.__historyCalls[0]).toEqual({
      userId: 'me',
      startHistoryId: '100',
    })
  })

  it('passes history_types and page_token through when supplied', async () => {
    const fake = makeFakeGmail({
      historyResponse: { history: [], historyId: '200' },
    })
    setGmailFactoryForTest(() => fake as never)

    const client = createGmailClient(1)
    await client.historyList({
      start_history_id: '100',
      history_types: ['messageAdded'],
      page_token: 'tok',
    })

    expect(fake.__historyCalls[0]).toEqual({
      userId: 'me',
      startHistoryId: '100',
      historyTypes: ['messageAdded'],
      pageToken: 'tok',
    })
  })

  it('returns { history, history_id, next_page_token } from the API response', async () => {
    const apiHistory = [{ id: 'h1', messagesAdded: [{ message: { id: 'm1', threadId: 't1' } }] }]
    const fake = makeFakeGmail({
      historyResponse: { history: apiHistory, historyId: '5000', nextPageToken: 'p2' },
    })
    setGmailFactoryForTest(() => fake as never)

    const client = createGmailClient(1)
    const result = await client.historyList({ start_history_id: '4000' })

    expect(result.history).toBe(apiHistory)
    expect(result.history_id).toBe('5000')
    expect(result.next_page_token).toBe('p2')
  })

  it('normalizes a missing history field to an empty array', async () => {
    const fake = makeFakeGmail({ historyResponse: { historyId: '5000' } })
    setGmailFactoryForTest(() => fake as never)

    const client = createGmailClient(1)
    const result = await client.historyList({ start_history_id: '0' })
    expect(result.history).toEqual([])
  })

  it('routes through session.withFreshTokens with the given accountId', async () => {
    const fake = makeFakeGmail({ historyResponse: { history: [] } })
    setGmailFactoryForTest(() => fake as never)

    const client = createGmailClient(77)
    await client.historyList({ start_history_id: '0' })

    expect(withFreshTokensSpy).toHaveBeenCalledTimes(1)
    expect(withFreshTokensSpy.mock.calls[0]?.[0]).toBe(77)
  })

  it('rethrows session errors verbatim', async () => {
    const err = new Error('invalid_grant: token revoked')
    withFreshTokensSpy.mockImplementationOnce(async () => {
      throw err
    })

    const client = createGmailClient(3)
    await expect(client.historyList({ start_history_id: '0' })).rejects.toBe(err)
  })

  it('rethrows API errors verbatim (e.g. 404 stale history)', async () => {
    const err = Object.assign(new Error('history id not found'), {
      response: { status: 404 },
    })
    const fake = makeFakeGmail({ historyError: err })
    setGmailFactoryForTest(() => fake as never)

    const client = createGmailClient(1)
    await expect(client.historyList({ start_history_id: '0' })).rejects.toBe(err)
  })
})

describe('createGmailClient.getProfile', () => {
  it('calls gmail.users.getProfile with userId="me"', async () => {
    const fake = makeFakeGmail({
      profileResponse: {
        emailAddress: 'a@x.com',
        historyId: '5000',
        messagesTotal: 12345,
        threadsTotal: 6789,
      },
    })
    setGmailFactoryForTest(() => fake as never)

    const client = createGmailClient(1)
    await client.getProfile()

    expect(fake.users.getProfile).toHaveBeenCalledTimes(1)
    expect(fake.__profileCalls[0]).toEqual({ userId: 'me' })
  })

  it('returns { email_address, history_id, messages_total, threads_total } snake_cased from the API', async () => {
    const fake = makeFakeGmail({
      profileResponse: {
        emailAddress: 'a@x.com',
        historyId: '5000',
        messagesTotal: 12345,
        threadsTotal: 6789,
      },
    })
    setGmailFactoryForTest(() => fake as never)

    const client = createGmailClient(1)
    const result = await client.getProfile()

    expect(result).toEqual({
      email_address: 'a@x.com',
      history_id: '5000',
      messages_total: 12345,
      threads_total: 6789,
    })
  })

  it('routes through session.withFreshTokens with the given accountId', async () => {
    const fake = makeFakeGmail({ profileResponse: {} })
    setGmailFactoryForTest(() => fake as never)

    const client = createGmailClient(42)
    await client.getProfile()

    expect(withFreshTokensSpy).toHaveBeenCalledTimes(1)
    expect(withFreshTokensSpy.mock.calls[0]?.[0]).toBe(42)
  })

  it('rethrows session errors verbatim', async () => {
    const err = new Error('invalid_grant')
    withFreshTokensSpy.mockImplementationOnce(async () => {
      throw err
    })

    const client = createGmailClient(3)
    await expect(client.getProfile()).rejects.toBe(err)
  })
})
