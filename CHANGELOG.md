# Changelog

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
