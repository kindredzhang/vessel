package httpapi

import (
	"net/http"
	"strings"
)

const (
	corsMethods     = "GET, POST, DELETE, OPTIONS"
	corsAllowHeader = "Authorization, Content-Type, X-Vessel-Token"
	corsMaxAge      = "600"
)

// corsMiddleware applies an exact-match Origin allowlist and answers
// preflight requests with 204.
func corsMiddleware(allowed []string) func(http.Handler) http.Handler {
	allowedSet := make(map[string]struct{}, len(allowed))
	for _, origin := range allowed {
		allowedSet[origin] = struct{}{}
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := strings.TrimSpace(r.Header.Get("Origin"))
			permitted := false
			if origin != "" {
				_, permitted = allowedSet[origin]
			}

			if permitted {
				header := w.Header()
				header.Set("Access-Control-Allow-Origin", origin)
				header.Add("Vary", "Origin")
				header.Set("Access-Control-Allow-Methods", corsMethods)
				header.Set("Access-Control-Allow-Headers", corsAllowHeader)
				header.Set("Access-Control-Max-Age", corsMaxAge)
			}

			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
