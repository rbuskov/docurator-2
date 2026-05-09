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

type FakeGmail = {
  users: {
    messages: {
      list: ReturnType<typeof vi.fn>
      get: ReturnType<typeof vi.fn>
    }
  }
  __listCalls: ListArgs[]
  __getCalls: GetArgs[]
}

function makeFakeGmail(opts: {
  listResponse?: unknown
  getResponse?: unknown
  listError?: Error
  getError?: Error
}): FakeGmail {
  const listCalls: ListArgs[] = []
  const getCalls: GetArgs[] = []
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
  return {
    users: { messages: { list, get } },
    __listCalls: listCalls,
    __getCalls: getCalls,
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
