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

type FakeGmail = {
  users: {
    messages: {
      list: ReturnType<typeof vi.fn>
      get: ReturnType<typeof vi.fn>
      attachments: {
        get: ReturnType<typeof vi.fn>
      }
    }
  }
  __listCalls: ListArgs[]
  __getCalls: GetArgs[]
  __attachmentCalls: AttachmentArgs[]
}

function makeFakeGmail(opts: {
  listResponse?: unknown
  getResponse?: unknown
  listError?: Error
  getError?: Error
  attachmentResponse?: unknown
  attachmentError?: Error
}): FakeGmail {
  const listCalls: ListArgs[] = []
  const getCalls: GetArgs[] = []
  const attachmentCalls: AttachmentArgs[] = []
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
  return {
    users: {
      messages: {
        list,
        get,
        attachments: { get: attachmentGet },
      },
    },
    __listCalls: listCalls,
    __getCalls: getCalls,
    __attachmentCalls: attachmentCalls,
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
