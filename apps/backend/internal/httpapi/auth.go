package httpapi

import (
	"crypto/subtle"
	"net/http"
	"strings"
)

// tokenHeader lets MyGo webviews authenticate, since they cannot always set
// an Authorization header on every request.
const tokenHeader = "X-Vessel-Token"

// authenticate enforces the static bearer token on everything under /v1.
func (s *server) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.allowInsecure {
			next.ServeHTTP(w, r)
			return
		}
		if !validToken(s.token, presentedToken(r)) {
			writeError(w, http.StatusUnauthorized, "unauthorized", "invalid or missing API token")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func presentedToken(r *http.Request) string {
	if header := r.Header.Get("Authorization"); header != "" {
		if len(header) > 7 && strings.EqualFold(header[:7], "Bearer ") {
			return strings.TrimSpace(header[7:])
		}
	}
	return strings.TrimSpace(r.Header.Get(tokenHeader))
}

func validToken(want, got string) bool {
	if want == "" || got == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(want), []byte(got)) == 1
}
