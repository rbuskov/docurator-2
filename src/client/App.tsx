import { BrowserRouter } from 'react-router-dom'
import { Nav } from './components/Nav.js'
import { AppRoutes } from './router.js'

export function App() {
  return (
    <BrowserRouter>
      <Nav />
      <AppRoutes />
    </BrowserRouter>
  )
}
