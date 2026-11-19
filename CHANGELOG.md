# Changelog

## Unreleased

- `vessel serve`: the agent runtime as an HTTP + SSE service — `/healthz`,
  sessions, turns, approvals, access-mode switching, abort; optional token auth.
- Desktop chat surface: session rail, streaming transcript, tool rows, approval
  card, mode switcher, stop button. It talks to the runtime, and shows the
  backend separately instead of pretending either is wired to the other.
- `VESSEL_THINKING` tunes the reasoning budget for gateways that spend it all.
- A finished turn is flagged `silent` when the model produced nothing, so the UI
  can say so instead of rendering an empty reply.

## 0.1.0

First scaffold.

- Three projects in one repository: `apps/agent-runtime` (Pi SDK agent),
  `apps/backend` (Go API + Postgres), `apps/desktop` (MyGo app for macOS and iOS).
- Agent runtime: model catalog from any OpenAI-compatible endpoint, four access
  modes (`plan` / `ask` / `auto` / `full`), audit log, `--yes` for headless runs.
- Backend: sessions and messages over a small JSON API, single-user bearer
  token, embedded goose migrations, `scratch` container image.
- Desktop: one Go module for macOS and iOS, React page, honest status of what is
  and is not wired.
