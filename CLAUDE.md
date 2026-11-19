
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## vessel (this repo)

An open-source coding agent in three projects. Read these before changing them:

| Path | Stack | What it owns |
| --- | --- | --- |
| `apps/agent-runtime` | Bun + TypeScript, Pi coding agent SDK | the agent: session, tools, model catalog, access modes |
| `apps/backend` | Go 1.27, chi, pgx, goose, Postgres | persistence and the HTTP API (single-user bearer token) |
| `apps/desktop` | Go 1.27 + MyGo + React/Vite + Tailwind | the window; builds macOS and iOS from one module |

- Desktop UI is assistant-ui primitives (`src/chat/Thread.tsx`) over Tailwind v4
tokens (`src/index.css`), not hand-written chat DOM. One runtime route:
`src/chat/wireRuntime.tsx` (`useChatRuntime` + a `ChatTransport`). The old
`ChatModelAdapter` route was deleted on purpose — do not reintroduce a second
message model; put new behaviour in the runtime's SSE frames or in
`src/chat/channel.ts`.
- The `## Frontend` section above (Bun HTML imports, "don't use vite") applies to
new Bun-served pages, **not** to `apps/desktop`, which builds through MyGo/Vite.

- Run: `make help` for every target. Typical loop: `make db`, `make backend`,
  `bun run serve`, `bun run desktop:dev`, `bun run runtime`.
- Dev and test models: use the `qingtian/*` models on the local gateway.
  `qingtian/dbtrt8tvcln3cqaun05g` (`deepseek-v4.1-flash-1017`) at
  `VESSEL_THINKING=xhigh` is the current recommendation; other models have
  streamed reasoning and then stopped without text.
- Checks: `make test`, `make typecheck`, `make fmt`.
- Layout rules: the backend never runs agent tools; the runtime never touches
  Postgres; the desktop app only talks HTTP. Keep those seams.
- Config is environment-only; add new variables to `.env.example` and the
  matching README table.
- Migrations: forward-only numbered files in
  `apps/backend/internal/store/migrations`, embedded in the binary.
- Docs: `docs/architecture.md` (decisions and open questions) and
  `apps/agent-runtime/docs/access-modes.md` (the four modes; guardrails, not a
  sandbox).
- Restarting the desktop app: `mygo dev` rebuilds Go only; a React change is a
  Vite HMR update.
