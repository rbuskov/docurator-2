import { Route, Routes } from 'react-router-dom'
import { Dashboard } from './views/Dashboard.js'
import { Inbox } from './views/Inbox.js'

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/inbox" element={<Inbox />} />
    </Routes>
  )
}
