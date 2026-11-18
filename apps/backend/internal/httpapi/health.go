package httpapi

import (
	"context"
	"net/http"
	"time"
)

const readyTimeout = 3 * time.Second

// healthz is a pure liveness probe: it never touches the database.
func (s *server) healthz(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"status":  "ok",
		"version": s.version,
	})
}

// readyz reports whether the database can serve queries.
func (s *server) readyz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), readyTimeout)
	defer cancel()

	if err := s.store.Ping(ctx); err != nil {
		s.logger.Warn("readiness probe failed", "error", err)
		writeError(w, http.StatusServiceUnavailable, "unavailable", "database unreachable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}
