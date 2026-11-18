// Package config loads vessel's runtime configuration from the environment.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"strings"
)

// DefaultCORSOrigins covers the local dev frontend plus MyGo's file and
// http origins, which browsers report as the literal "null" origin.
const DefaultCORSOrigins = "http://localhost:5173,http://127.0.0.1:5173,null"

// Config holds every knob the daemon exposes. It is populated from env vars
// only, so the binary stays 12-factor friendly.
type Config struct {
	Listen        string
	DatabaseURL   string
	APIToken      string
	AllowInsecure bool
	AutoMigrate   bool
	CORSOrigins   []string
	LogLevel      slog.Level
}

// Load reads the environment and returns a validated Config.
func Load() (*Config, error) {
	cfg := &Config{
		Listen:      getenv("VESSEL_LISTEN", ":8080"),
		DatabaseURL: strings.TrimSpace(os.Getenv("DATABASE_URL")),
		APIToken:    strings.TrimSpace(os.Getenv("VESSEL_API_TOKEN")),
		CORSOrigins: splitList(getenv("VESSEL_CORS_ORIGINS", DefaultCORSOrigins)),
	}

	var errs []error
	var err error
	if cfg.AllowInsecure, err = parseBool("VESSEL_ALLOW_INSECURE", os.Getenv("VESSEL_ALLOW_INSECURE"), false); err != nil {
		errs = append(errs, err)
	}
	if cfg.AutoMigrate, err = parseBool("VESSEL_AUTO_MIGRATE", os.Getenv("VESSEL_AUTO_MIGRATE"), true); err != nil {
		errs = append(errs, err)
	}
	if cfg.LogLevel, err = parseLevel(getenv("VESSEL_LOG_LEVEL", "info")); err != nil {
		errs = append(errs, err)
	}
	if err := cfg.Validate(); err != nil {
		errs = append(errs, err)
	}
	if len(errs) > 0 {
		return nil, fmt.Errorf("invalid configuration: %w", joinErrors(errs))
	}
	return cfg, nil
}

// Validate checks the invariants the server relies on at startup.
func (c *Config) Validate() error {
	if strings.TrimSpace(c.Listen) == "" {
		return fmt.Errorf("VESSEL_LISTEN must not be empty")
	}
	if c.DatabaseURL == "" {
		return fmt.Errorf("DATABASE_URL is required")
	}
	u, err := url.Parse(c.DatabaseURL)
	if err != nil {
		return fmt.Errorf("DATABASE_URL is not a valid URL: %w", err)
	}
	switch u.Scheme {
	case "postgres", "postgresql":
	default:
		return fmt.Errorf("DATABASE_URL must use the postgres:// or postgresql:// scheme")
	}
	if c.APIToken == "" && !c.AllowInsecure {
		return fmt.Errorf("VESSEL_API_TOKEN is required unless VESSEL_ALLOW_INSECURE=1")
	}
	return nil
}

// OriginAllowed reports whether origin is on the exact-match allowlist.
func (c *Config) OriginAllowed(origin string) bool {
	for _, allowed := range c.CORSOrigins {
		if allowed == origin {
			return true
		}
	}
	return false
}

func getenv(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func splitList(raw string) []string {
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func parseBool(key, raw string, fallback bool) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "":
		return fallback, nil
	case "1", "true", "yes", "on":
		return true, nil
	case "0", "false", "no", "off":
		return false, nil
	default:
		return false, fmt.Errorf("%s: invalid boolean %q", key, raw)
	}
}

func parseLevel(raw string) (slog.Level, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", "info":
		return slog.LevelInfo, nil
	case "debug":
		return slog.LevelDebug, nil
	case "warn", "warning":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	default:
		return slog.LevelInfo, fmt.Errorf("VESSEL_LOG_LEVEL: invalid level %q", raw)
	}
}

func joinErrors(errs []error) error {
	msgs := make([]string, 0, len(errs))
	for _, err := range errs {
		msgs = append(msgs, err.Error())
	}
	return errors.New(strings.Join(msgs, "; "))
}
