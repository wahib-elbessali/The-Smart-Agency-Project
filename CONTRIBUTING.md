# Contributing to SmartAgency

## Repo layout

- `hardware/` — IoT firmware and hardware glue
- `ai/` — computer vision pipeline
- `integration/` — glue code translating raw hardware/AI events into contract-shaped data for the backend
- `backend/` — internal ingestion endpoints + the public-facing endpoints the frontend consumes
- `frontend/` — dashboard
- `contracts/` — source of truth for API/JSON shapes (see below)
- `docs/` — the user guide and the developer guide (start with `docs/developer-guide.md`)

## Mock-first workflow

Physical hardware and the AI/CV pipeline run in one place. Don't assume you have access to real sensors, cameras, or a live backend:

- Build and test backend/frontend work against `contracts/api.md` and `contracts/ingestion.md`, not real hardware.
- Write your own mocks/fixtures for the code you're building — you own testing your own code.
- If you genuinely need the real local stack, ask in `#blockers`.

## Contracts

- `contracts/api.md` — public endpoints the frontend consumes.
- `contracts/ingestion.md` — internal endpoints that receive events from hardware/AI.
- No dedicated contract-owner role — whoever builds a piece writes its own entry, using the template at the top of each file.
- Breaking change (altering or removing an existing field/endpoint, not just adding a new optional one): prefix the PR title with `BREAKING:` exactly. This isn't just convention — a workflow reads the PR title when the PR merges and posts to `#api-contract`, with a callout if the title starts with `BREAKING:`. Get the prefix right or it won't flag.

## Git / PR workflow

- No direct pushes to `master` — everything goes through a PR.
- One approval required before merging. The approver can never be the PR's author.
- CI must pass — no exceptions.
- PRs can be as light or heavy as the change calls for. No requirement to scope to a single feature, and no requirement to link a kanban card or issue.
- Review is normal back-and-forth — comment, revise, re-review. Nothing gets rejected outright without discussion.

## Kanban board

- Anyone can create, edit, or delete a feature card — no gatekeeping.
- Status only: todo / in-progress / done.
- "Done" means merged, not just moved. This is trust-based, not enforced by anything — if you move a card to done, you're vouching that the work actually landed.

## `#blockers`

- One shared inbox, open any time.
- Non-trivial questions use the 3-line template: what you're stuck on / what you've tried / what you think the fix might be. Tag it with the layer it belongs to (foundation/backend/frontend) when you post.
- Entries get triaged — mistagged or untagged ones corrected, duplicates merged, anything already answered closed — and routed to whoever owns that layer.
- Answers come on a schedule, not live — except `urgent`, reserved for things actually blocking everyone (broken CI, a hardware safety issue), which gets an immediate response.
- A quick direct ping is fine for something genuinely fast; anything that needs real thought gets redirected to `#blockers`.
