import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './App'
import { SessionProvider } from '@/auth/session'
import { ScopeProvider } from '@/agency/scope'
import { ThemeProvider } from '@/theme/theme'
import { ApiError } from '@/api/errors'
import { beginSessionRestore } from '@/api/tokenStore'
import './mocks'
/* Fonts are bundled, not fetched from a CDN: the dashboard runs on one local
   machine with no guaranteed network, and a font server being unreachable
   must not change what the screen looks like. Only the weights in use. */
import '@fontsource-variable/ibm-plex-sans'
import '@fontsource-variable/oxanium'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // Retrying a missing fixture or a 4xx just delays the honest error.
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.kind !== 'network') return false
        return failureCount < 2
      },
    },
  },
})

/* A tab with no session of its own asks the other open tabs for theirs before
   the first render, so opening a new tab does not mean signing in again. */
beginSessionRestore()

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element #root is missing from index.html')

createRoot(rootElement).render(
  <StrictMode>
    {/* Outermost: the theme applies to the login screen and to any error
        boundary too, both of which render outside the session. */}
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <SessionProvider>
          {/* Inside the session because the branch an admin is working in is
              theirs, and has to be dropped when they are. */}
          <ScopeProvider>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </ScopeProvider>
        </SessionProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
