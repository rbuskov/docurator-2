import { NavLink } from 'react-router-dom'

export function Nav() {
  return (
    <header>
      <h1>Docurator</h1>
      <nav>
        <NavLink to="/" end>
          Dashboard
        </NavLink>{' '}
        <NavLink to="/inbox">Inbox</NavLink>
      </nav>
    </header>
  )
}
