# Frontend security notes

The dashboard is a client bundle. Anything it holds, a person with the page open
holds too. These are the rules that follow from that, and what enforces each.

## No secrets in the bundle

Vite inlines every `VITE_`-prefixed variable into the built JavaScript **in
plain text**. `VITE_API_BASE_URL` is a URL and fine. An API key, a token, a
database password or a signing secret is not — it ships to every viewer.

Anything secret stays on the backend, behind an endpoint.

Enforced by `src/checks/bundle.test.ts`, which builds nothing but scans the
committed `.env.example` and fails if a variable name looks like a credential.

## XSS

React escapes interpolated values, so the realistic hole is
`dangerouslySetInnerHTML`, `eval`, and `javascript:` URLs.

Enforced by lint: `react/no-danger`, `react/no-danger-with-children`, `no-eval`
and `no-script-url` are **errors** in `.oxlintrc.json`, so `npm run lint` fails
rather than a reviewer having to spot it.

If a screen ever genuinely needs to render backend HTML, that is a conversation
before it is a code change — sanitising on the client is the weakest place to do
it.

## CSRF

Not yet applicable and deliberately not guessed at.

`src/api/client.ts` sets `credentials: 'same-origin'` explicitly rather than
relying on the default. If the backend ends up using cookie sessions, two things
have to change together:

1. `credentials` becomes `'include'`
2. state-changing requests echo a CSRF token

The token's header name and how it is issued are the **backend's** to define.
They are not invented here. If instead we get bearer tokens, CSRF stops being
relevant and token storage becomes the question.

### Where the session token lives (changed 2026-10-02)

The signed-in session (access token, refresh token, user) is kept in a module
variable, mirrored into `sessionStorage`, and shared between the browser's open
tabs (`src/api/tokenStore.ts`), so a page reload, typing a URL, or opening a new
tab no longer signs you out.

This replaced an earlier rule that kept tokens in memory only, so that an XSS
could not read them back out. That protection is what was traded away: **script
running on the page can now read the session from `sessionStorage`.** It is a
deliberate choice for day-to-day usability, made by the project owner:

- Not `localStorage`. A new tab asks the tabs that are already open for the
  session over a same-origin `BroadcastChannel` and adopts the answer, so the
  session still **ends when the last tab closes** instead of lasting the refresh
  token's whole lifetime (three and a half days) on disk.
- Signing out in one tab signs out the others, and a sign-in or token refresh in
  one is passed on, so no tab is left holding a stale token. A different user's
  session is never swapped in underneath a tab that is signed in as someone else.
- A stored or received session is shape-checked before it is trusted, and
  unreadable storage or a missing `BroadcastChannel` just means "signed out" for
  that tab.
- On load, an expired access token is refreshed straight away; if the refresh
  token is rejected the session ends cleanly.

The stronger option, if this needs tightening later: have the backend set the
refresh token as an `HttpOnly` cookie (with the CORS and CSRF handling that
implies) and keep only the short-lived access token in memory, restoring it
with a silent refresh on load. That keeps reload-survival without exposing a
long-lived credential to script.

## Auth

`src/auth/` has the session state, the route guard, and the login screen. The
guard is **enforced by default** — only `VITE_AUTH_ENFORCED=false` turns it off,
so a missing `.env` file cannot unlock the app. It was opt-in while the sign-in
request shape was unknown, and the result was that a fresh clone let anyone
straight into every screen, which is the failure mode this default exists to
prevent.

Understand what it is and isn't. This is a **client-side** guard: it decides
which screens render, nothing more. It is not an access control boundary, and it
cannot be — anyone can edit the bundle in their own browser. Every endpoint has
to enforce its own authorisation server-side, and the guard is there so an
unauthenticated user meets a login screen instead of a dashboard full of failed
requests.

With `VITE_USE_MOCKS=true` any credentials are accepted, because the fixtures
exercise session plumbing rather than verify anyone. Do not serve a mock build
anywhere it could be mistaken for the real thing.

## Still open

- **Content-Security-Policy.** Belongs on whatever serves the built assets, as a
  response header, so it is a deployment decision rather than a frontend one.
  Worth raising once we know how this gets served.
- **Dependency advisories.** `npm audit` is clean today. Nothing runs it on a
  schedule yet.
