import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Recover from stale code-split chunks after a deploy. Each build gives the
// lazy-loaded route chunks new content-hashed filenames, so a tab that was
// already open before a deploy will request a chunk name that no longer exists
// and fail with "Failed to fetch dynamically imported module". Vite fires
// `vite:preloadError` in that case; reload once to pick up the fresh build
// instead of dead-ending on the route error screen. The timestamp guard avoids
// a reload loop when a chunk is genuinely unavailable (then the route error
// boundary still shows), while still allowing recovery again on a later deploy.
const PRELOAD_RELOAD_KEY = 'hb:preload-reloaded-at'
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault()
  const lastReload = Number(sessionStorage.getItem(PRELOAD_RELOAD_KEY) || 0)
  if (Date.now() - lastReload < 10000) {
    // We just reloaded; the chunk is probably genuinely missing, not stale —
    // stop here so the route error boundary can show instead of looping.
    return
  }
  sessionStorage.setItem(PRELOAD_RELOAD_KEY, String(Date.now()))
  window.location.reload()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
