# SmartAgency UX / IA Audit

**Date:** 2026-09-23
**Scope:** Structural/information-architecture problems found by using the real app end to end (real backend, real frontend, mocked AI/IoT) and cross-checking the patterns against the actual backend schema and industry practice for multi-tenant dashboards and queue management systems. Not a visual-polish review — every item below is a hierarchy or data-model problem, not a styling one.

---

## Finding 1 — No forced "choose your agency" entry point

`Agencies` is a flat item in the sidebar nav, the same visual weight as `Climate` or `Watchlist`. For an ADMIN (the only role that can see more than one branch), there is no step that forces "which branch am I working in" before landing on real data. You can open the app and start looking at Employees, Devices, or Alerts without ever having chosen an agency.

Industry pattern for this (Notion's workspace switcher is the standard reference): switching context should change the logo, clear the sidebar, and repopulate it with only that workspace's data, so you never have to wonder whose data you're looking at. SmartAgency does the opposite — the "scope bar" that filters by agency is optional, easy to never discover, and appears only after a specific action (opening an agency from the Agencies list).

---

## Finding 2 — Agency scoping is implemented four different, inconsistent ways

Checked the actual scoping code in every screen. Four separate mechanisms exist for the same question ("which branch does this data belong to"):

| Mechanism | Screens | Behavior |
|---|---|---|
| Passive global scope bar only | `Employees.tsx`, `Devices.tsx`, `EmployeePresence.tsx` | Does nothing until the admin has separately gone to Agencies and clicked "Open" on one. Until then: every branch's data, mixed flat. |
| Own local branch dropdown, reimplemented per screen | `Services.tsx`, `Zones.tsx`, `Cameras.tsx` | Three screens, three separate implementations of the same "pick a branch" selector. |
| No scoping at all | `Users.tsx` | Always shows every account from every agency. Doesn't read the scope bar at all, confirmed in source. |
| Drill-into-one or grid-of-all | `Climate.tsx`, `Insights.tsx` | A fourth, different pattern (built this way deliberately in a recent session, but still a fourth model). |

A real multi-tenant switcher is supposed to be one mechanism the whole app trusts. The research framing for why this matters: "a user acting in the wrong workspace makes the product feel dangerous." Right now a MANAGER's own screens are correctly locked server-side, but an ADMIN has to learn a different UI convention on every single screen to find out whether "the branch I'm looking at" even applies here.

---

## Finding 3 — Queue is anchored to the agent, not the counter (backend schema issue, not just UI)

Confirmed at the data-model level, not just the screen: `User.assigned_counter` is a foreign key that lives on the **User** table (`backend/app/models/entities.py`), pointing at a `Counter`. The backend literally models "who is working counter 3" as an attribute of the *employee*, not as an attribute of the *counter*.

This is backwards from reality: counters are the stable, physical thing; the person behind one rotates (breaks, shift changes, sick days). Concretely: if Nadia goes on break and Youssef covers her window, the system has to record this as "Youssef is now the person with counter-assignment X" — there's no way to say "counter 3 is being covered by someone else right now," because the counter itself has no independent state to hold that.

**There's already a correct counterexample in the same app**: `Staffing.tsx` (Counter staffing) does this the right way — a `Workstation` is the stable entity, bound to a `Zone`, and "is anyone there right now" is a derived, live status, never an assignment relationship. Visitor queue should follow the same shape Staffing already proved works.

Industry framing: queue systems should route people to the best-suited counter/resource, with the person staffing it being interchangeable on top of that — not the reverse.

---

## Finding 4 — Counters can't be created, edited, or removed after the branch exists

Checked the backend routes directly. `Counter` is a real, persistent entity (own id, `service_id`, `name`, `number`, `is_open` flag) — but there is **no route anywhere** to add, rename, reassign, or delete one once an agency has been created. The only place a `Counter` row is ever written is inside `POST /agencies`, at the moment a brand-new branch is created (`app/api/agencies.py`).

There's an explicit comment in `AgencyForm.tsx` admitting this: *"there is no route that adds a counter to an agency that already exists."*

Practical consequence: a branch that wants to open a 5th teller window, rename "Guichet 2" to something clearer, or permanently retire a counter **cannot do it through this application at all** — not through the UI, because there's no backend route to call.

Real commercial queue-management systems treat this as baseline functionality — every one surveyed describes service points as "customizable, add or remove as needed for branch operations."

---

## Finding 5 — Camera/spatial features have an invisible, undocumented setup order

There's a real dependency chain: **Calibration → Zones → (Staffing / Tracking / Occupancy)**. You cannot use the live map without calibrating cameras first; you cannot bind a Staffing workstation without a Zone existing first. Checked all three downstream screens:

- `Staffing.tsx` — its empty state links back to `/zones` ("Areas are drawn on Zones").
- `Occupancy.tsx` — empty state gives **no link, no hint** about Zones or Calibration.
- `Tracking.tsx` (Live map) — same: no cross-link, no mention of the calibration prerequisite.

So one of the three screens in this chain tries to guide you; the other two just show an empty state with no explanation of what's missing or where to go fix it.

---

## Finding 6 — Sidebar is one flat, unsectioned list of ~20 items

No grouping distinguishes:
- **Configuration** screens (Zones, Calibration, Services, Users, Devices)
- **Monitoring** screens (Alerts, Insights, Live map, Occupancy)
- **Day-to-day operational** screens (Visitor queue, Employee presence, Manual controls)

A first-time user (of any role) has no way to build a mental model of what a screen even *is* — a one-time setup step, an always-on dashboard, or a daily task — before clicking into it.

---

## Fix plan — all six done, 2026-09-23/24

1. **Nav sectioning** (Finding 6) — ✅ done. Sidebar grouped into Operations / Monitoring / Configuration (`auth/screens.ts`, `AppShell.tsx`).
2. **Cross-links from Occupancy and Tracking** (Finding 5) — ✅ done. Both now link back to Zones/Calibration from their empty states, matching Staffing.
3. **Unify agency scoping to one mechanism** (Finding 2) — ✅ done. Services/Zones/Cameras' own local `pickedAgencyId` state removed in favour of the shared `ScopeContext`; `Users.tsx` (previously unscoped entirely) now filters by it too.
4. **Agency switcher as the real entry point** (Finding 1) — ✅ done. A branch switcher is now always visible in the header for an ADMIN, not just after visiting Agencies and opening one.
5. **Counters management screen + backend routes** (Finding 4) — ✅ done. New `backend/app/api/counters.py` (`GET/POST /agencies/{id}/counters`, `PUT/DELETE /counters/{id}`), new `CountersPanel` on `AgencyDetail.tsx`.
6. **Move queue assignment off the agent** (Finding 3) — ✅ done, scoped differently than first planned. Rather than a full FK migration (Counter's identity was never actually the problem — `Ticket.counter_id` was already counter-anchored), the real bugs were (a) nothing stopped two agents sharing one counter's `counter_id` simultaneously, fixed with a DB-level partial unique index (migration `5b14b5b07703`) plus the assignment endpoint now relieving the previous agent automatically, and (b) `VisitorQueue.tsx` presenting agents as the primary list with counters as their attribute. Rebuilt the screen counter-first: every staffable counter listed with a "who's covering this" picker, same underlying assignment endpoint, read the other way round.

All six verified live against the real backend (not just unit-tested) during the session that fixed them.
