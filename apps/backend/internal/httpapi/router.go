// Package httpapi is vessel's HTTP control plane.
package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"runtime/debug"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
	"github.com/vesselhq/vessel/apps/backend/internal/store"
)

const (
	defaultTimeout = 30 * time.Second
	defaultVersion = "dev"
)

// Store is the persistence surface the handlers need. *store.Store satisfies it.
type Store interface {
	Ping(ctx context.Context) error
	CreateSession(ctx context.Context, p store.CreateSessionParams) (store.Session, error)
	ListSessions(ctx context.Context, limit int) ([]store.Session, error)
	GetSession(ctx context.Context, id uuid.UUID) (store.Session, error)
	DeleteSession(ctx context.Context, id uuid.UUID) error
	AddMessage(ctx context.Context, p store.AddMessageParams) (store.Message, error)
	ListMessages(ctx context.Context, sessionID uuid.UUID) ([]store.Message, error)
}

// Options configures the router. Handlers depend only on this, never on env vars.
type Options struct {
	Store          Store
	Token          string
	AllowInsecure  bool
	AllowedOrigins []string
	Version        string
	Logger         *slog.Logger
	Timeout        time.Duration
}

type server struct {
	store         Store
	token         string
	allowInsecure bool
	version       string
	logger        *slog.Logger
	origins       []string
}

// NewRouter builds the full HTTP stack: middleware, health probes and the
// protected /v1 API. It performs no I/O and is safe to use in tests.
func NewRouter(opts Options) http.Handler {
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	version := opts.Version
	if version == "" {
		version = defaultVersion
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = defaultTimeout
	}

	s := &server{
		store:         opts.Store,
		token:         opts.Token,
		allowInsecure: opts.AllowInsecure,
		version:       version,
		logger:        logger,
		origins:       opts.AllowedOrigins,
	}

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(s.accessLog)
	r.Use(s.recoverer)
	r.Use(timeoutMiddleware(timeout))
	r.Use(corsMiddleware(s.origins))

	r.NotFound(func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not_found", "resource not found")
	})
	r.MethodNotAllowed(func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
	})

	r.Get("/healthz", s.healthz)
	r.Get("/readyz", s.readyz)

	r.Route("/v1", func(r chi.Router) {
		r.Use(s.authenticate)
		r.Post("/sessions", s.createSession)
		r.Get("/sessions", s.listSessions)
		r.Get("/sessions/{id}", s.getSession)
		r.Delete("/sessions/{id}", s.deleteSession)
		r.Post("/sessions/{id}/messages", s.addMessage)
		r.Get("/sessions/{id}/messages", s.listMessages)
	})

	return r
}

func (s *server) accessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)

		s.logger.Info("http request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"duration_ms", float64(time.Since(start).Microseconds())/1000.0,
			"request_id", middleware.GetReqID(r.Context()),
		)
	})
}

func (s *server) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			rec := recover()
			if rec == nil {
				return
			}
			if rec == http.ErrAbortHandler {
				panic(rec)
			}
			s.logger.Error("panic recovered",
				"panic", rec,
				"stack", string(debug.Stack()),
				"method", r.Method,
				"path", r.URL.Path,
				"request_id", middleware.GetReqID(r.Context()),
			)
			writeError(w, http.StatusInternalServerError, "internal", "internal server error")
		}()
		next.ServeHTTP(w, r)
	})
}

// timeoutMiddleware bounds handler work and answers 503 if the deadline wins.
// Unlike http.TimeoutHandler it lets the handler goroutine wind down naturally.
func timeoutMiddleware(d time.Duration) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx, cancel := context.WithTimeout(r.Context(), d)
			defer cancel()

			tw := &timeoutWriter{w: w}
			done := make(chan struct{})
			var panicVal any

			go func() {
				defer func() {
					if p := recover(); p != nil {
						panicVal = p
					}
					close(done)
				}()
				next.ServeHTTP(tw, r.WithContext(ctx))
			}()

			select {
			case <-done:
				if panicVal != nil {
					panic(panicVal)
				}
			case <-ctx.Done():
				if tw.expire() {
					writeError(w, http.StatusServiceUnavailable, "timeout", "request timed out")
				}
			}
		})
	}
}

// timeoutWriter drops writes once the request has timed out and reports the
// status code back to the access logger.
type timeoutWriter struct {
	w           http.ResponseWriter
	mu          sync.Mutex
	wroteHeader bool
	status      int
	timedOut    bool
}

func (t *timeoutWriter) Header() http.Header { return t.w.Header() }

func (t *timeoutWriter) WriteHeader(code int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.wroteHeader || t.timedOut {
		return
	}
	t.wroteHeader = true
	t.status = code
	t.w.WriteHeader(code)
}

func (t *timeoutWriter) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.timedOut {
		return 0, http.ErrHandlerTimeout
	}
	if !t.wroteHeader {
		t.wroteHeader = true
		t.status = http.StatusOK
		t.w.WriteHeader(http.StatusOK)
	}
	return t.w.Write(p)
}

// expire marks the request as timed out and reports whether a response was
// still unsent, i.e. whether a 503 can be written.
func (t *timeoutWriter) expire() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.timedOut = true
	return !t.wroteHeader
}

// statusRecorder captures the status code for logging.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(p []byte) (int, error) {
	return r.ResponseWriter.Write(p)
}
