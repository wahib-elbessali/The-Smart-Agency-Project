# `src/mocks/fixtures/`

One file per endpoint group, each calling `registerMock()` with its variants:
`normal`, `empty`, `large`, and optionally `error`.

Register every file in `src/mocks/index.ts` so it loads at startup — a fixture
nobody imports never registers, and the endpoint fails with `not_implemented`
as though it had never been written.

## Read fixtures vs writable stores

A fixture set is four pure functions keyed by scenario. That works for reads
and not at all for writes: a create has a request body, has to change what
subsequent reads return, and can legitimately fail on a uniqueness clash. So
anything writable lives in a **store** next door — `employeeStore`,
`agencyStore`, `ticketStore`, `attendanceStore` — and the fixture registers it
with `registerMockWriter()`.

Where a store exists, the `normal` variant should read **through** it rather
than returning a frozen array, or a row created in the UI will not appear in
the list that follows. `empty` and `large` stay frozen: they exist to test
rendering at the extremes, not to be edited.

Stores also enforce the refusals the backend enforces, with the same status
codes — a duplicate counter number is a 409, a name outside 2–150 characters is
a 422. A mock that accepts everything produces a form nobody has actually
tested, and the first real refusal then arrives in front of a user.

## Shape to follow

```ts
import { registerMock } from '@/mocks/registry'
import { somethingEndpoint, type SomethingResponse } from '@/api/endpoints/something'

registerMock<SomethingResponse>(somethingEndpoint.key, {
  normal: () => ({/* copied field-for-field from the contract */}),
  empty: () => ({/* zero rows — the state that ships broken most often */}),
  large: () => ({/* 200 rows — does the table still work? */}),
})
```

Copy field names from the contract character for character; `occupancy_count`
and `occupancyCount` are different fields. When a `BREAKING:` post appears in
`#api-contract`, come back and check these against the contract.

The VALUES are invented — that is what a fixture is — but no field name is.
