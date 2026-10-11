import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { SessionProvider } from './hooks/useSession';
import { ThemeProvider } from './hooks/useTheme';
import { ToastProvider } from './components/ui/Toast';
import './styles/global.css';

// After a new deploy, a tab left open still holds the OLD index.html, which
// points at chunk files the new deploy has replaced — so the next lazy route
// import 404s with "Failed to fetch dynamically imported module". Recover by
// reloading once to pick up the fresh index.html and its current chunks. The
// one-shot guard (sessionStorage) stops a reload loop if the asset is genuinely
// missing rather than merely stale.
function recoverFromStaleChunk(message: string) {
  if (!/dynamically imported module|Importing a module script failed|error loading dynamically imported/i.test(message)) {
    return;
  }
  try {
    if (sessionStorage.getItem('devnexus.chunkReloaded') === '1') return;
    sessionStorage.setItem('devnexus.chunkReloaded', '1');
  } catch { /* private mode — still try the reload */ }
  window.location.reload();
}
window.addEventListener('vite:preloadError', (e) => {
  e.preventDefault();
  recoverFromStaleChunk(String((e as unknown as { payload?: { message?: string } }).payload?.message ?? 'dynamically imported module'));
});
window.addEventListener('error', (e) => recoverFromStaleChunk(String(e.message ?? '')));
window.addEventListener('unhandledrejection', (e) => recoverFromStaleChunk(String(e.reason?.message ?? e.reason ?? '')));
// A clean load clears the guard so a later genuine stale-chunk can recover too.
window.addEventListener('load', () => {
  try { sessionStorage.removeItem('devnexus.chunkReloaded'); } catch { /* ignore */ }
});

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    {/* Theme sits outermost so it applies before anything renders; session next,
        because routing decisions depend on it; toasts innermost, since only
        screens use them. */}
    <ThemeProvider>
      <BrowserRouter>
        <SessionProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </SessionProvider>
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
);
