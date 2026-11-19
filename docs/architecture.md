# Architecture

Three processes, one repository. Each owns one thing, and none of them reaches
into another's internals.

```text
┌──────────────────────────────┐        ┌──────────────────────────────┐
│ apps/desktop  (Go · MyGo)    │  HTTP  │ apps/backend  (Go)           │
│                              │ ─────► │                              │
│ WKWebView + React page       │  /v1   │ chi · pgx · goose            │
│ macOS · iOS from one module  │        │ bearer token, single user    │
└──────────────────────────────┘        └──────────────┬───────────────┘
                                                       │ SQL
                                                       ▼
                                              ┌──────────────────┐
                                              │ Postgres 14+     │
                                              └──────────────────┘

┌──────────────────────────────┐
│ apps/agent-runtime  (Bun)    │   ← standalone today, wired to the backend next
│ Pi SDK session · tools       │
│ model catalog · access modes │
└──────────────────────────────┘
```

## Responsibilities

**`apps/desktop`** — the window. A MyGo Go module opens a window and binds one
service (`Runtime.Info`) that reports the version, platform and the backend URL.
The page inside is React + Vite + Tailwind v4, using assistant-ui primitives
for the thread, composer and message parts. MyGo generates the TypeScript client
(`src/mygo.ts`) from the Go methods, so the boundary is typed in both
directions. The same module builds a macOS `.app`/`.dmg` and an iOS `.ipa`; on
iOS the page renders in WKWebView and the Go code runs as the app.

**`apps/backend`** — the deployable half. It owns Postgres and the HTTP API:
sessions, messages, health. Single-user mode is a deliberate v1 choice: one
bearer token (`VESSEL_API_TOKEN`), no registration, no multi-tenancy. That keeps
the self-hosted story honest — `docker compose up`, one secret, done — while
leaving room for accounts later without a schema rewrite (the tables already
have stable ids and timestamps).

**`apps/agent-runtime`** — the agent. It builds a Pi SDK session: the model
catalog comes from one OpenAI-compatible endpoint, tools are the SDK's own
(`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`), and one `tool_call`
extension implements the four access modes. It runs headless (`vessel "prompt"`),
as a REPL, as a library, or as `vessel serve` — an HTTP + SSE service that the
window drives. The runtime is the only process that talks to the model, so
credentials and the access gate stay in one place.

### Two routes into the same thread

The chat surface can drive the runtime two ways, switchable at runtime, because
the choice is a real trade-off and not a settled one:

- **assistant-ui adapter** — `useLocalRuntime` with a `ChatModelAdapter`. The
  adapter owns the message list and yields a fresh part snapshot per SSE event,
  so tool calls, reasoning and text are ordinary assistant-ui parts. Approval
  requests travel out of band through a small `TurnChannel` object that the
  adapter also feeds (`approval`, `settled`, `failed`). Least machinery; the
  message model is assistant-ui's.
- **AI SDK transport** — `useChatRuntime` with a `ChatTransport` that maps our
  SSE frames onto `UIMessageChunk`s (`text-start`/`text-delta`/`reasoning-*`/
  `tool-input-available`/`tool-output-available`). The AI SDK assembles and
  owns the messages, which is where its ecosystem (persistence adapters,
  telemetry, resumable streams) plugs in. Costs one dependency and a second
  message model; it is lazily imported so route A never downloads it.

Neither route knows about access modes: the runtime decides whether a tool call
needs approval and emits an `approval` frame; the UI renders it, the answer goes
back to `POST /v1/sessions/:id/approvals`. Keep that seam — anything that makes
one route smarter than the other means the runtime is leaking UI policy.

## Why these choices

- **MyGo over Electron/Tauri:** one Go module produces desktop *and* iOS builds
  with the OS webview, no cgo on desktop, no bundled Chromium. The UI stays web
  technology, so the eventual chat surface can be built with normal React tools.
- **Go backend, not TypeScript:** the runtime is already a Node-shaped process;
  keeping the server in Go gives a single static binary, predictable memory, and
  a `scratch`-based non-root image. It also matches MyGo's language, so contributors who read
  one can read the other.
- **Postgres only:** one database, one migration tool, no dialect branching.
  pgx + goose keeps SQL visible; there is no ORM hiding query plans.
- **Env-only config:** `DATABASE_URL` is the only coupling to infrastructure, so
  the same binary runs against Docker, Neon or RDS.
- **Access modes live in the runtime:** the backend stores `access_mode` as a
  label but never enforces it. Enforcement belongs next to the tools, where it
  can see the actual call. The UI will only *switch* the mode.

## Request flow (target state)

1. The desktop app creates a session: `POST /v1/sessions`.
2. It starts a runtime turn with the session id and the chosen access mode.
3. The runtime streams deltas and tool events; the backend appends each finished
   turn to `messages` so a transcript survives restarts.
4. Approvals for `ask` / `auto` render in the window; the answer goes back to the
   runtime's gate (`POST /v1/sessions/:id/approvals`), never through the database.

Steps 1–4 work today against the local runtime (`bun run serve`, `:8787`). What is
still missing is step 3's second half: the runtime does not post finished turns to
the backend, and its own sessions are in memory, so a runtime restart clears the
transcript. The window shows the backend and the runtime as two separate,
truthfully-labelled dependencies instead of one fake "connected" indicator.

## Honest boundaries

- Access modes are **guardrails, not a sandbox**: an approved `bash` command can
  still write files internally. A real fence needs restricted `BashOperations`
  (container, seatbelt, landlock) — see `apps/agent-runtime/docs/access-modes.md`.
- The backend trusts its single token completely. Do not expose it to the public
  internet without TLS and a reverse proxy.
- The desktop app talks to `VESSEL_API_URL`, defaulting to `localhost:8080`. A
  remote deployment needs CORS entries (`VESSEL_CORS_ORIGINS`) for the app's
  origin.

## Known limitations

- Runtime sessions are in memory. Restarting `vessel serve` drops them, and the
  window will say `no session <id>` if you click a stale entry — the honest
  failure, not a silent one. Persisting them (or forwarding turns to the backend)
  is the next milestone.
- Both routes render the same history shape (text, reasoning, tool names and
  their one-line summaries). Tool *results* are not persisted into the
  transcript: the runtime keeps names, arguments and status, so a reloaded
  session shows what was run, not what it printed.
- Some gateways stream reasoning and then stop without content; the turn is then
  flagged `silent` and the UI says so. `VESSEL_THINKING=off` avoids the budget
  being spent entirely on reasoning.

## Open questions

- Where does the runtime execute: on the user's machine (as today) or next to
  the backend for multi-device sessions? Their answers differ on whether
  transcripts or repositories leave the machine.
- Do sessions belong to a workspace path? Today `sessions` has no project or
  repository column; the UI will need one.
- Which route wins? Both are maintained for now so the difference is felt before
  it is decided — the adapter route is less code, the transport route buys the
  AI SDK's message pipeline.
- Model catalog: the runtime discovers models from the endpoint per process. If
  the backend should show them, it needs either a cached catalog table or a
  proxy endpoint.
