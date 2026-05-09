import { afterEach, describe, expect, it } from 'vitest'

describe('jsdom env', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('exposes a working DOM via jsdom', () => {
    const el = document.createElement('div')
    el.textContent = 'hello'
    document.body.appendChild(el)

    expect(document.body.contains(el)).toBe(true)
    expect(document.body.querySelector('div')?.textContent).toBe('hello')
  })
})
