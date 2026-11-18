package store

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"log/slog"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Migrate applies the embedded migrations. goose records applied versions in
// goose_db_version, so the call is safe to repeat on every boot.
func Migrate(ctx context.Context, databaseURL string) error {
	db, err := sql.Open("pgx", databaseURL)
	if err != nil {
		return fmt.Errorf("open database for migrations: %w", err)
	}
	defer db.Close()

	goose.SetBaseFS(migrationsFS)
	goose.SetLogger(gooseLogger{logger: slog.Default()})
	if err := goose.SetDialect("postgres"); err != nil {
		return fmt.Errorf("set goose dialect: %w", err)
	}
	if err := goose.UpContext(ctx, db, "migrations"); err != nil {
		return fmt.Errorf("run migrations: %w", err)
	}

	version, err := goose.GetDBVersionContext(ctx, db)
	if err != nil {
		return fmt.Errorf("read migration version: %w", err)
	}
	slog.Info("database migrations up to date", "goose_version", version)
	return nil
}

// gooseLogger routes goose output through slog instead of stdout.
type gooseLogger struct {
	logger *slog.Logger
}

func (g gooseLogger) Printf(format string, v ...any) {
	g.logger.Debug("goose: " + fmt.Sprintf(format, v...))
}

func (g gooseLogger) Fatalf(format string, v ...any) {
	g.logger.Error("goose: " + fmt.Sprintf(format, v...))
}
