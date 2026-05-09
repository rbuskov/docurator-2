import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { Nav } from './Nav.js'

describe('<Nav />', () => {
  it('renders the Docurator heading and both nav links', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Nav />
      </MemoryRouter>,
    )

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Docurator')
    const dashboard = screen.getByRole('link', { name: 'Dashboard' })
    const inbox = screen.getByRole('link', { name: 'Inbox' })
    expect(dashboard.getAttribute('href')).toBe('/')
    expect(inbox.getAttribute('href')).toBe('/inbox')
  })

  it('marks the Dashboard link as the current page when on "/"', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Nav />
      </MemoryRouter>,
    )

    expect(screen.getByRole('link', { name: 'Dashboard' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'Inbox' }).getAttribute('aria-current')).not.toBe('page')
  })

  it('marks the Inbox link as the current page when on "/inbox"', () => {
    render(
      <MemoryRouter initialEntries={['/inbox']}>
        <Nav />
      </MemoryRouter>,
    )

    expect(screen.getByRole('link', { name: 'Inbox' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('link', { name: 'Dashboard' }).getAttribute('aria-current')).not.toBe('page')
  })
})
