# Contributing

Thanks for helping. Vessel is three projects in one repository, and each has one
way to check itself.

```bash
bun install
make test        # Bun tests, go vet, Go tests (no database needed)
make typecheck
make fmt
```

For changes that touch the backend, also run it against a real database:

```bash
cp .env.example .env
make db
make backend
curl -s -H "Authorization: Bearer $VESSEL_API_TOKEN" localhost:8080/v1/sessions
```

## Ground rules

- **Keep the seams.** The backend stores state, the runtime owns the agent, the
  desktop app renders. A change that reaches across a seam needs a reason in the
  pull request.
- **No placeholder features.** If something is not wired, say so in the UI and
  in the README instead of faking it.
- **Migrations are forward-only.** Add a new numbered file under
  `apps/backend/internal/store/migrations`; never edit an applied one.
- **Config through the environment.** New settings get an entry in `.env.example`
  and a row in the relevant README table.
- **Tests come with the change:** pure logic gets unit tests; anything touching
  SQL gets a test that runs when `DATABASE_URL` is set.
- **Commits:** imperative subject, one concern per commit; no generated files
  (`src/mygo.ts`, `dist/`, `build/`) in the diff.

## Reporting security issues

Open a private security advisory on GitHub rather than a public issue. The
single-user token model means a leak is a full compromise of one deployment.

## Licensing

By contributing you agree your work is licensed under Apache-2.0.
