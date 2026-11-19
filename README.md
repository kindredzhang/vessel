# Vessel

An open-source coding agent you can host yourself: a Go backend, a TypeScript
agent runtime built on the [Pi coding agent SDK](https://www.npmjs.com/package/@earendil-works/pi-coding-agent),
and one interface that runs on macOS and iOS.

[![ci](https://github.com/kindredzhang/vessel/actions/workflows/ci.yml/badge.svg)](https://github.com/kindredzhang/vessel/actions/workflows/ci.yml)

> **Status: scaffold.** The three projects run and talk to what they own; the
> agent is deliberately not wired to the UI yet. See [Roadmap](#roadmap).

## The three pieces

| Project | Language | Owns | Runs as |
| --- | --- | --- | --- |
| [`apps/backend`](apps/backend) | Go 1.27 · chi · pgx · Postgres | persistence, HTTP API, auth token | server or container |
| [`apps/agent-runtime`](apps/agent-runtime) | TypeScript · Bun · Pi SDK | the session, tools, model catalog, access modes | local process |
| [`apps/desktop`](apps/desktop) | Go 1.27 · [MyGo](https://mygo.run) · React | the window and its UI, macOS + iOS from one codebase | desktop app, simulator |

```
vessel/
├── apps/
│   ├── backend/          Go API: sessions, messages, migrations, Dockerfile
│   ├── agent-runtime/    Pi SDK agent: CLI, tools, access modes
│   └── desktop/          MyGo shell (Go) + React page (Vite)
├── docs/architecture.md  how the pieces fit, and what is still open
├── docker-compose.yml    Postgres for development, backend on a profile
├── go.work               the two Go modules, one workspace
└── Makefile              make help
```

## Quickstart

Prerequisites: [Bun](https://bun.sh) 1.2+, [Go](https://go.dev/dl/) 1.27+,
Docker (or your own Postgres). iOS builds additionally need Xcode.

```bash
git clone https://github.com/vesselhq/vessel && cd vessel
cp .env.example .env          # dev defaults; change VESSEL_API_TOKEN
bun install

make db                       # Postgres 17 in Docker on :5432
make backend                  # API on :8080, migrations run at startup
bun run serve                 # agent runtime on :8787 (HTTP + SSE)
bun run desktop:dev           # the macOS window, live reload
```

The window is a chat surface: it talks to the agent runtime over HTTP and shows
the backend separately in its status line. Turns stream token by token, tool
calls appear as they happen, and in `ask` mode an approval card stops a call
before it runs.

Run the agent on its own:

```bash
cd apps/agent-runtime
cp .env.example .env          # any OpenAI-compatible endpoint
bun run vessel "what does this project do?"
```

On a phone:

```bash
cd apps/desktop
bun run dev:ios               # booted simulator (needs Xcode)
bun run build:ios             # signed .ipa
```

### The chat surface

The window is [assistant-ui](https://www.assistant-ui.com) primitives on
Tailwind v4 tokens, not a chat written from scratch: `ThreadPrimitive`,
`ComposerPrimitive`, `MessagePrimitive.Parts` and a streaming markdown
renderer, styled with the same paper-and-ink palette as the rest of the app
(`src/index.css` holds the tokens for both colour schemes).

The surface reads the runtime through **one route: the AI SDK transport**.
`useChatRuntime` owns the chat through `useChat`, and a single `ChatTransport`
turns our SSE frames into `UIMessageChunk`s (`text-start` / `text-delta`,
`reasoning-*`, `tool-input-*` / `tool-output-*`, `finish`). Past that
translation the message model is the AI SDK's, which is the point: persistence
adapters, telemetry and resumption all speak it.

The seam that makes this honest is that the runtime's frame vocabulary
(`text`, `thinking`, `tool`, `approval`, `done`) is **ours**, not the SDK's and
not the AI SDK's — the runtime never learns what renders it. Approval prompts
are not part of either message protocol, so they travel out of band: an SSE
frame in, a `POST /v1/sessions/:id/approvals` back.

```bash
bun run serve                 # the runtime the UI talks to
bun run desktop:dev           # the window; it talks to that runtime
```

[docs/two-routes.html](docs/two-routes.html) is the record of how we decided:
it walks one turn through each candidate route, frame by frame — the snapshot a
`ChatModelAdapter` would yield versus the chunks the transport sends. The
adapter route was removed after that comparison; the page is kept because the
reasoning is worth keeping. Open it in a browser; no server needed.

## Install the app

**macOS.** Download the `.dmg` from
[Releases](https://github.com/kindredzhang/vessel/releases), drag Vessel to
Applications. Release builds are ad-hoc signed until project maintainers add an
Apple Developer ID, so the first launch needs right-click → Open (or
`xattr -dr com.apple.quarantine /Applications/Vessel.app`). Notarized builds —
no warning at all — come with a paid Apple Developer Program membership; see
[`docs/releasing.md`](docs/releasing.md).

**iOS.** There are three ways, in increasing order of "other people can use it":

| Path | Needs | How a user installs |
| --- | --- | --- |
| Simulator | Xcode | `bun run dev:ios` |
| Own iPhone | free Apple ID + Xcode | build from Xcode, app expires after 7 days |
| **TestFlight** | paid Developer Program (99 USD/yr) | TestFlight app + invite or public link, no UDID |

TestFlight is how iOS betas normally ship: Apple hosts the build, testers install
the free TestFlight app from the App Store, accept the invitation, and get Vessel
in one tap — nothing to sign, no device registration, builds last 90 days. The
one-time setup (App ID, App Store Connect API key, `bun run publish -- -platform ios`)
is written out step by step in [`docs/releasing.md`](docs/releasing.md).

## Backend

Go, `net/http` + chi, pgx for Postgres, goose migrations embedded in the binary.

```bash
curl -s localhost:8080/healthz
curl -s -H "Authorization: Bearer $VESSEL_API_TOKEN" localhost:8080/v1/sessions
docker compose --profile app up -d --build     # API + database in containers
```

| Endpoint | Meaning |
| --- | --- |
| `GET /healthz` | liveness, never touches the database |
| `GET /readyz` | readiness, pings Postgres |
| `POST /v1/sessions` | create a session (`title`, `model`, `access_mode`) |
| `GET /v1/sessions` | list sessions, newest first |
| `GET|DELETE /v1/sessions/{id}` | read or delete one |
| `GET|POST /v1/sessions/{id}/messages` | read a transcript, append a turn |

Config is environment only — see [`apps/backend/README.md`](apps/backend/README.md)
for every variable, migration workflow and the Docker image.

## Database

Two supported shapes, as open-source projects usually offer:

- **Development:** `make db` starts `postgres:17-alpine` with a named volume.
  `make db-reset` throws it away.
- **Bring your own:** set `DATABASE_URL` to any Postgres 14+ (Neon, RDS, a local
  server) and skip Docker entirely. Nothing in the app assumes it owns the
  database; migrations run at startup or via the goose CLI (`make migrate`).

## Agent runtime

The runtime is a standalone CLI and library: it owns the model catalog (one
OpenAI-compatible endpoint, every model it reports), the tool set, and the four
access modes (`plan` / `ask` / `auto` / `full`). Its access gate is a single
`tool_call` extension, so the backend and the UI never have to know about it.
Read [`apps/agent-runtime/README.md`](apps/agent-runtime/README.md) and
[`apps/agent-runtime/docs/access-modes.md`](apps/agent-runtime/docs/access-modes.md).

```bash
bun run runtime                     # REPL
bun run runtime "list the files"    # one-shot
bun run runtime:models              # what the endpoint reports
```

## Scripts

| Command | Does |
| --- | --- |
| `make help` | list every target |
| `make db` / `make db-reset` | start or recreate the dev database |
| `make backend` | run the API with `.env` loaded |
| `bun run desktop:dev` | MyGo app with Vite live reload |
| `bun run runtime` | agent runtime CLI |
| `bun run serve` | agent runtime over HTTP + SSE (`:8787`) |
| `make test` | Bun tests + `go vet` + Go tests |
| `make typecheck` | TypeScript projects |
| `make fmt` | gofmt both Go modules |
| `make desktop-ipa` | build the iOS app (TestFlight distribution) |
| `make desktop-publish` | upload the iOS build to TestFlight |

## Open-source conventions we follow

- **Apache-2.0**, no telemetry, no phone-home — you can audit every dependency.
- **12-factor config:** environment only, `.env.example` as the reference.
- **Self-host first:** one Postgres, one binary, one token. Docker Compose for
  development and a `scratch`-based, non-root image for deployment.
- **Migrations in the source of truth:** embedded with the binary, also usable
  with the goose CLI; forward-only in production.
- **CI on every push:** Bun tests, Go vet/tests against a real Postgres service,
  web build, and a Docker build of the backend.

## Roadmap

1. ~~Access modes, model catalog, CLI~~ — done in `apps/agent-runtime`.
2. ~~Monorepo, backend API, MyGo shell~~ — this scaffold.
3. ~~Chat surface in the desktop app, with the four access-mode controls~~ —
   the window streams turns from `bun run serve`, through either an
   assistant-ui adapter or an AI SDK transport.
4. Persist runtime sessions (they live in memory today) and let the runtime post
   turns to the backend for history and multi-device access.
5. Hard bash sandbox (`BashOperations`) so modes are a fence, not a guardrail.

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md). Security issues: please open a private
report rather than a public issue. Licensed under [Apache-2.0](LICENSE).
