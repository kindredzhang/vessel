# One entry point for the whole monorepo. `make help` lists the targets.
SHELL := /bin/bash
.DEFAULT_GOAL := help

DATABASE_URL ?= postgres://vessel:vessel@localhost:5432/vessel?sslmode=disable
VENV_ENV := set -a; [ -f .env ] && source .env; set +a;

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

.PHONY: setup
setup: ## Install Bun and Go dependencies
	bun install
	cd apps/backend && go mod download

.PHONY: db
db: ## Start Postgres in Docker (default dev database)
	docker compose up -d db
	@echo "Postgres on localhost:$${POSTGRES_PORT:-5432} — DATABASE_URL=$(DATABASE_URL)"

.PHONY: db-down
db-down: ## Stop Postgres, keep its volume
	docker compose down

.PHONY: db-reset
db-reset: ## Destroy the dev database and start an empty one
	docker compose down -v && docker compose up -d db

.PHONY: migrate
migrate: ## Apply migrations with the goose CLI (needs goose installed)
	cd apps/backend && goose -dir internal/store/migrations postgres "$(DATABASE_URL)" up

.PHONY: backend
backend: ## Run the Go API on :8080 (migrations run at startup)
	$(VENV_ENV) cd apps/backend && go run ./cmd/vesseld

.PHONY: backend-docker
backend-docker: ## Run the API and database with Docker
	docker compose --profile app up -d --build

.PHONY: desktop
desktop: ## Run the desktop/mobile app with live reload
	cd apps/desktop && bun run dev

.PHONY: desktop-ios
desktop-ios: ## Run on the iOS simulator (needs Xcode)
	cd apps/desktop && bun run dev:ios

.PHONY: desktop-build
desktop-build: ## Package the app for this machine (app + dmg)
	cd apps/desktop && bun run build

.PHONY: desktop-ipa
desktop-ipa: ## Build the iOS app (needs Xcode; team/profile for devices)
	cd apps/desktop && bun run build -- -platform ios

.PHONY: desktop-publish
desktop-publish: ## Upload the iOS build to TestFlight (paid Apple account)
	cd apps/desktop && bun run publish -- -platform ios

.PHONY: runtime
runtime: ## Run the agent runtime CLI
	cd apps/agent-runtime && bun run vessel

.PHONY: test
test: ## Run every test suite that does not need a database
	bun run --cwd apps/agent-runtime test
	cd apps/backend && go vet ./... && go test ./...

.PHONY: typecheck
typecheck: ## Typecheck TypeScript projects
	bun run --cwd apps/agent-runtime typecheck
	cd apps/desktop && bun run typecheck

.PHONY: fmt
fmt: ## Format Go code
	cd apps/backend && gofmt -w .
	cd apps/desktop && gofmt -w .
