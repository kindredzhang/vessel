# vessel backend

The deployable control plane for [vessel](https://github.com/vesselhq/vessel), an
open-source coding agent. It owns conversations, not model traffic: the TypeScript
agent runtime executes tools and streams completions, while this service persists
sessions and messages and exposes them over a small JSON API to the MyGo frontend.

## Why Postgres

Sessions and messages are relational (messages cascade from sessions, sessions are
listed by recent activity) and the queries are trivial. Postgres gives us
`timestamptz`, real UUID defaults, `ON DELETE CASCADE`, and one dependency that
self-hosters already know how to run. There is deliberately no ORM, no cache, and
no queue: one process, one pool.

Single-user, self-hosted v1: there is no registration or login. A static bearer
token protects the API.

## Quickstart

The database comes from the repository root compose file:

```sh
# from the repository root
docker compose up -d db

# from apps/backend
export DATABASE_URL='postgres://vessel:vessel@localhost:5432/vessel?sslmode=disable'
export VESSEL_API_TOKEN="$(openssl rand -hex 32)"
go run ./cmd/vesseld
```

`vesseld` applies the embedded migrations on startup (`VESSEL_AUTO_MIGRATE=1`),
then listens on `:8080`. Check it:

```sh
curl -s localhost:8080/healthz
curl -s localhost:8080/readyz
```

### Migrations without the binary

Auto-migrate is the default. If you prefer to run migrations explicitly, disable it
and use the goose CLI against the same directory:

```sh
go install github.com/pressly/goose/v3/cmd/goose@latest

VESSEL_AUTO_MIGRATE=0 \
  goose -dir internal/store/migrations postgres "$DATABASE_URL" up
```

The migrations are also embedded in the binary, so a containerized deploy needs no
extra tooling.

## Configuration

Everything is environment driven.

| Variable | Default | Notes |
| --- | --- | --- |
| `VESSEL_LISTEN` | `:8080` | HTTP listen address. |
| `DATABASE_URL` | — (required) | `postgres://` or `postgresql://` URL. |
| `VESSEL_API_TOKEN` | — (required) | Static bearer token. Required unless `VESSEL_ALLOW_INSECURE=1`. |
| `VESSEL_ALLOW_INSECURE` | `0` | Accept unauthenticated `/v1` calls. Logs a loud WARN. Local dev only. |
| `VESSEL_AUTO_MIGRATE` | `1` | Run embedded goose migrations at startup. |
| `VESSEL_CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173,null` | Comma-separated, exact-match `Origin` allowlist. |
| `VESSEL_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. |

## API

All responses are JSON with snake_case fields. Errors always use the envelope
`{"error":{"code":"...","message":"..."}}`. Everything under `/v1` requires the
token, sent either as `Authorization: Bearer <token>` or `X-Vessel-Token: <token>`
(the latter exists for MyGo webviews).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | Liveness; never touches the database. |
| `GET` | `/readyz` | Readiness; `SELECT 1` against Postgres. |
| `POST` | `/v1/sessions` | Create a session. |
| `GET` | `/v1/sessions` | List sessions, newest activity first (`?limit=1..200`, default 100). |
| `GET` | `/v1/sessions/{id}` | Fetch one session. |
| `DELETE` | `/v1/sessions/{id}` | Delete a session and its messages. |
| `POST` | `/v1/sessions/{id}/messages` | Append a message, bumping the session's `updated_at`. |
| `GET` | `/v1/sessions/{id}/messages` | List a session's messages oldest first. |

### Examples

```sh
TOKEN="$(openssl rand -hex 32)"
H="Authorization: Bearer $TOKEN"

# create a session (title, model and access_mode are optional)
curl -s -X POST localhost:8080/v1/sessions \
  -H "$H" -H 'Content-Type: application/json' \
  -d '{"title":"Fix the failing test","model":"vessel-1","access_mode":"ask"}'

# list sessions
curl -s localhost:8080/v1/sessions -H "$H"

# append a user message
curl -s -X POST localhost:8080/v1/sessions/<id>/messages \
  -H "$H" -H 'Content-Type: application/json' \
  -d '{"role":"user","content":"why is store_test failing?"}'

# read the transcript
curl -s localhost:8080/v1/sessions/<id>/messages -H "$H"

# delete
curl -s -X DELETE localhost:8080/v1/sessions/<id> -H "$H"
```

`access_mode` must be one of `plan`, `ask`, `auto`, `full` (default `ask`);
message `role` must be one of `user`, `assistant`, `system`, `tool`.

## Project layout

```
cmd/vesseld/main.go              # startup: config, migrate, store, HTTP, graceful shutdown
internal/config/config.go        # env -> Config + Validate()
internal/httpapi/router.go       # chi stack, middleware, Store interface
internal/httpapi/{health,auth,sessions,respond,cors}.go
internal/httpapi/router_test.go  # stub-store handler tests (no database needed)
internal/store/store.go          # pgxpool queries, ErrNotFound mapping
internal/store/migrate.go        # embedded goose runner
internal/store/migrations/       # SQL migrations
internal/store/store_test.go     # Postgres-backed tests (skipped without DATABASE_URL)
```

## Testing

```sh
go build ./...
go vet ./...
go test ./...        # handler tests always run; store tests skip without DATABASE_URL

DATABASE_URL='postgres://vessel:vessel@localhost:5432/vessel?sslmode=disable' go test ./...
```

## Docker

```sh
docker build --build-arg VERSION=0.1.0 -t vessel-backend .

docker run --rm -p 8080:8080 \
  -e DATABASE_URL='postgres://vessel:vessel@host.docker.internal:5432/vessel?sslmode=disable' \
  -e VESSEL_API_TOKEN="$VESSEL_API_TOKEN" \
  vessel-backend
```

The runtime image is `scratch` plus CA roots, runs as uid 10001, and
needs only `DATABASE_URL` and `VESSEL_API_TOKEN`. Compose can build and run it for
you: `docker compose --profile app up -d --build` from the repository root.

If your network cannot reach `proxy.golang.org`, pass another proxy
(`--build-arg GOPROXY=https://goproxy.cn,direct`) or commit a vendor directory and
build with `-mod=vendor`.

## Open-source conventions

- Twelve-factor config: all behaviour comes from environment variables, with a
  hand-rolled parser so there is no config library to audit.
- Migrations ship inside the binary via `go:embed`, so upgrades are a single image
  swap; goose's version table keeps them idempotent.
- The image is non-root and shell-free, built with `CGO_ENABLED=0` for a static
  binary.
- `/healthz` and `/readyz` are separate so orchestrators can distinguish "alive"
  from "database reachable".
