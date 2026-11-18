// Command vesseld is vessel's HTTP control plane.
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/vesselhq/vessel/apps/backend/internal/config"
	"github.com/vesselhq/vessel/apps/backend/internal/httpapi"
	"github.com/vesselhq/vessel/apps/backend/internal/store"
)

// version is injected at build time via -ldflags "-X main.version=...".
var version = "dev"

func main() {
	if err := run(); err != nil {
		slog.Error("vesseld exited", "error", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}

	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel}))
	slog.SetDefault(logger)

	if cfg.AllowInsecure {
		logger.Warn("VESSEL_ALLOW_INSECURE=1: the API is reachable without a token; never do this in production")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	bootCtx, cancelBoot := context.WithTimeout(ctx, 60*time.Second)
	defer cancelBoot()

	if cfg.AutoMigrate {
		if err := store.Migrate(bootCtx, cfg.DatabaseURL); err != nil {
			return err
		}
	} else {
		logger.Info("automatic migrations disabled; run goose yourself")
	}

	db, err := store.New(bootCtx, cfg.DatabaseURL)
	if err != nil {
		return err
	}
	defer db.Close()

	handler := httpapi.NewRouter(httpapi.Options{
		Store:          db,
		Token:          cfg.APIToken,
		AllowInsecure:  cfg.AllowInsecure,
		AllowedOrigins: cfg.CORSOrigins,
		Version:        version,
		Logger:         logger,
	})

	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("vesseld listening", "addr", cfg.Listen, "version", version)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- fmt.Errorf("listen: %w", err)
			return
		}
		errCh <- nil
	}()

	select {
	case err := <-errCh:
		return err
	case <-ctx.Done():
		logger.Info("shutdown signal received")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("graceful shutdown: %w", err)
	}
	return <-errCh
}
