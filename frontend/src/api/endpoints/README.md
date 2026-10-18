# `src/api/endpoints/`

One file per endpoint group. Each exports typed functions that screens call,
and this directory is the **only** place allowed to name a `contracts/api.md`
path. Screens call these; they never call `client.ts` directly, and they never
build a URL themselves.

That single rule is what keeps swapping fixtures for a real backend a change to
`.env` alone.

## Shape to follow

```ts
import { fetchJson } from '../client'
import type { Something } from '../types'

export function fetchSomething(signal?: AbortSignal): Promise<Something[]> {
  return fetchJson<Something[]>(
    { key: 'GET /api/something', path: '/api/something', auth: true },
    { signal },
  )
}
```

- **`key`** is the registry key the mock layer matches on. Convention is
  `METHOD /path`, with `{id}` standing in for a path parameter.
- **`path`** is the real URL, exactly as `contracts/api.md` writes it.
- **`auth`** is explicit per endpoint rather than "send a token whenever we
  have one", because `POST /api/auth/login` is the one call that must NOT carry
  a stale token — and a default-on rule makes that an easy accident.

## What belongs in the doc comment

Transcribe the parts of the contract entry a caller cannot see from the
signature, and nothing else:

- **Which roles may call it**, and what the other roles get. "SECURITY receives
  403" saves someone an afternoon.
- **Every error status and what triggers it.** A 409 that means "already
  exists" and a 409 that means "wrong state" need different handling.
- **Anything surprising in the success path.** `POST /api/attendance/check-in`
  returns the EXISTING record with a 200 when the employee is already inside —
  a caller that reads any 200 as "checked in just now" will report a time that
  never happened.
- **Cascades.** `DELETE /api/agencies/{id}` also destroys that agency's
  employees, visitors, devices, cameras and alerts.

Re-read the contract entry each time you touch one of these — not the fixture
you wrote three weeks ago.
