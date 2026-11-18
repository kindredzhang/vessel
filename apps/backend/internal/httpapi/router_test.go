package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/vesselhq/vessel/apps/backend/internal/store"
)

const testToken = "test-token-0123456789"

// stubStore implements Store with per-test function hooks. Unset hooks panic
// so accidentally exercised paths are obvious.
type stubStore struct {
	ping           func(ctx context.Context) error
	createSession  func(ctx context.Context, p store.CreateSessionParams) (store.Session, error)
	listSessions   func(ctx context.Context, limit int) ([]store.Session, error)
	getSession     func(ctx context.Context, id uuid.UUID) (store.Session, error)
	deleteSession  func(ctx context.Context, id uuid.UUID) error
	addMessage     func(ctx context.Context, p store.AddMessageParams) (store.Message, error)
	listMessages   func(ctx context.Context, sessionID uuid.UUID) ([]store.Message, error)
	lastCreateArgs store.CreateSessionParams
	lastListLimit  int
}

func (s *stubStore) Ping(ctx context.Context) error {
	if s.ping == nil {
		return nil
	}
	return s.ping(ctx)
}

func (s *stubStore) CreateSession(ctx context.Context, p store.CreateSessionParams) (store.Session, error) {
	s.lastCreateArgs = p
	if s.createSession == nil {
		panic("stubStore.CreateSession not configured")
	}
	return s.createSession(ctx, p)
}

func (s *stubStore) ListSessions(ctx context.Context, limit int) ([]store.Session, error) {
	s.lastListLimit = limit
	if s.listSessions == nil {
		panic("stubStore.ListSessions not configured")
	}
	return s.listSessions(ctx, limit)
}

func (s *stubStore) GetSession(ctx context.Context, id uuid.UUID) (store.Session, error) {
	if s.getSession == nil {
		panic("stubStore.GetSession not configured")
	}
	return s.getSession(ctx, id)
}

func (s *stubStore) DeleteSession(ctx context.Context, id uuid.UUID) error {
	if s.deleteSession == nil {
		panic("stubStore.DeleteSession not configured")
	}
	return s.deleteSession(ctx, id)
}

func (s *stubStore) AddMessage(ctx context.Context, p store.AddMessageParams) (store.Message, error) {
	if s.addMessage == nil {
		panic("stubStore.AddMessage not configured")
	}
	return s.addMessage(ctx, p)
}

func (s *stubStore) ListMessages(ctx context.Context, sessionID uuid.UUID) ([]store.Message, error) {
	if s.listMessages == nil {
		panic("stubStore.ListMessages not configured")
	}
	return s.listMessages(ctx, sessionID)
}

func newTestRouter(t *testing.T, st Store) http.Handler {
	t.Helper()
	if st == nil {
		st = &stubStore{}
	}
	return NewRouter(Options{
		Store:          st,
		Token:          testToken,
		AllowedOrigins: []string{"http://localhost:5173", "null"},
		Version:        "test",
		Logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		Timeout:        2 * time.Second,
	})
}

func doRequest(t *testing.T, handler http.Handler, method, path string, body any, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()

	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		reader = bytes.NewReader(raw)
	}

	req := httptest.NewRequest(method, path, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func authorized() map[string]string {
	return map[string]string{"Authorization": "Bearer " + testToken}
}

func decodeBody[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var out T
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode response %q: %v", rec.Body.String(), err)
	}
	return out
}

func errorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	return decodeBody[errorEnvelope](t, rec).Error.Code
}

func TestHealthz(t *testing.T) {
	handler := newTestRouter(t, nil)
	rec := doRequest(t, handler, http.MethodGet, "/healthz", nil, nil)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	body := decodeBody[map[string]string](t, rec)
	if body["status"] != "ok" {
		t.Errorf("status = %q, want ok", body["status"])
	}
	if body["version"] != "test" {
		t.Errorf("version = %q, want test", body["version"])
	}
}

func TestReadyzUnavailable(t *testing.T) {
	st := &stubStore{ping: func(context.Context) error { return errors.New("db down") }}
	handler := newTestRouter(t, st)
	rec := doRequest(t, handler, http.MethodGet, "/readyz", nil, nil)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", rec.Code)
	}
	if code := errorCode(t, rec); code != "unavailable" {
		t.Errorf("code = %q, want unavailable", code)
	}
}

func TestUnauthorized(t *testing.T) {
	handler := newTestRouter(t, &stubStore{listSessions: func(context.Context, int) ([]store.Session, error) {
		return nil, nil
	}})

	tests := []struct {
		name    string
		headers map[string]string
	}{
		{name: "no token", headers: nil},
		{name: "wrong bearer", headers: map[string]string{"Authorization": "Bearer nope"}},
		{name: "wrong x-vessel-token", headers: map[string]string{tokenHeader: "nope"}},
		{name: "malformed authorization", headers: map[string]string{"Authorization": testToken}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rec := doRequest(t, handler, http.MethodGet, "/v1/sessions", nil, tc.headers)
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("status = %d, want 401", rec.Code)
			}
			if code := errorCode(t, rec); code != "unauthorized" {
				t.Errorf("code = %q, want unauthorized", code)
			}
		})
	}
}

func TestAuthHeaderVariants(t *testing.T) {
	st := &stubStore{listSessions: func(context.Context, int) ([]store.Session, error) {
		return []store.Session{}, nil
	}}
	handler := newTestRouter(t, st)

	tests := []struct {
		name    string
		headers map[string]string
	}{
		{name: "bearer", headers: authorized()},
		{name: "x-vessel-token", headers: map[string]string{tokenHeader: testToken}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rec := doRequest(t, handler, http.MethodGet, "/v1/sessions", nil, tc.headers)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200, body=%s", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestAllowInsecureSkipsAuth(t *testing.T) {
	st := &stubStore{listSessions: func(context.Context, int) ([]store.Session, error) {
		return nil, nil
	}}
	handler := NewRouter(Options{
		Store:         st,
		AllowInsecure: true,
		Version:       "test",
		Logger:        slog.New(slog.NewTextHandler(io.Discard, nil)),
	})

	rec := doRequest(t, handler, http.MethodGet, "/v1/sessions", nil, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}

func TestCreateSession(t *testing.T) {
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	id := uuid.MustParse("11111111-1111-1111-1111-111111111111")

	tests := []struct {
		name       string
		body       map[string]any
		wantStatus int
		wantCode   string
		wantTitle  string
		wantModel  string
		wantMode   string
	}{
		{
			name:       "defaults",
			body:       map[string]any{"model": "vessel-1"},
			wantStatus: http.StatusCreated,
			wantTitle:  defaultSessionTitle,
			wantModel:  "vessel-1",
			wantMode:   defaultAccessMode,
		},
		{
			name:       "explicit fields",
			body:       map[string]any{"title": "Fix tests", "model": "vessel-1", "access_mode": "plan"},
			wantStatus: http.StatusCreated,
			wantTitle:  "Fix tests",
			wantModel:  "vessel-1",
			wantMode:   "plan",
		},
		{
			name:       "invalid access mode",
			body:       map[string]any{"access_mode": "root"},
			wantStatus: http.StatusUnprocessableEntity,
			wantCode:   "invalid_access_mode",
		},
		{
			name:       "invalid json",
			wantStatus: http.StatusBadRequest,
			wantCode:   "invalid_json",
			body:       nil,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			st := &stubStore{createSession: func(_ context.Context, p store.CreateSessionParams) (store.Session, error) {
				return store.Session{
					ID:         id,
					Title:      p.Title,
					Model:      p.Model,
					AccessMode: p.AccessMode,
					CreatedAt:  now,
					UpdatedAt:  now,
				}, nil
			}}
			handler := newTestRouter(t, st)

			rec := doRequest(t, handler, http.MethodPost, "/v1/sessions", tc.body, authorized())
			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d, body=%s", rec.Code, tc.wantStatus, rec.Body.String())
			}
			if tc.wantCode != "" {
				if code := errorCode(t, rec); code != tc.wantCode {
					t.Errorf("code = %q, want %q", code, tc.wantCode)
				}
				return
			}

			got := decodeBody[sessionResponse](t, rec)
			if got.ID != id {
				t.Errorf("id = %s, want %s", got.ID, id)
			}
			if got.Title != tc.wantTitle || got.Model != tc.wantModel || got.AccessMode != tc.wantMode {
				t.Errorf("session = %+v, want title=%q model=%q mode=%q", got, tc.wantTitle, tc.wantModel, tc.wantMode)
			}
			if st.lastCreateArgs.Title != tc.wantTitle || st.lastCreateArgs.AccessMode != tc.wantMode {
				t.Errorf("store args = %+v", st.lastCreateArgs)
			}
			if loc := rec.Header().Get("Location"); loc != "/v1/sessions/"+id.String() {
				t.Errorf("Location = %q", loc)
			}
		})
	}
}

func TestListSessionsLimit(t *testing.T) {
	st := &stubStore{listSessions: func(context.Context, int) ([]store.Session, error) {
		return []store.Session{{ID: uuid.New(), Title: "a"}}, nil
	}}
	handler := newTestRouter(t, st)

	rec := doRequest(t, handler, http.MethodGet, "/v1/sessions?limit=5", nil, authorized())
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if st.lastListLimit != 5 {
		t.Errorf("limit = %d, want 5", st.lastListLimit)
	}

	for _, raw := range []string{"0", "201", "abc"} {
		rec := doRequest(t, handler, http.MethodGet, "/v1/sessions?limit="+raw, nil, authorized())
		if rec.Code != http.StatusBadRequest {
			t.Errorf("limit=%s status = %d, want 400", raw, rec.Code)
		}
	}
}

func TestGetSessionNotFound(t *testing.T) {
	st := &stubStore{getSession: func(context.Context, uuid.UUID) (store.Session, error) {
		return store.Session{}, store.ErrNotFound
	}}
	handler := newTestRouter(t, st)

	rec := doRequest(t, handler, http.MethodGet, "/v1/sessions/"+uuid.NewString(), nil, authorized())
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if code := errorCode(t, rec); code != "not_found" {
		t.Errorf("code = %q, want not_found", code)
	}
}

func TestGetSessionInvalidID(t *testing.T) {
	handler := newTestRouter(t, &stubStore{})
	rec := doRequest(t, handler, http.MethodGet, "/v1/sessions/not-a-uuid", nil, authorized())
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if code := errorCode(t, rec); code != "invalid_id" {
		t.Errorf("code = %q, want invalid_id", code)
	}
}

func TestDeleteSessionNotFound(t *testing.T) {
	st := &stubStore{deleteSession: func(context.Context, uuid.UUID) error {
		return store.ErrNotFound
	}}
	handler := newTestRouter(t, st)

	rec := doRequest(t, handler, http.MethodDelete, "/v1/sessions/"+uuid.NewString(), nil, authorized())
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestAddMessage(t *testing.T) {
	sessionID := uuid.New()
	now := time.Now().UTC()

	st := &stubStore{addMessage: func(_ context.Context, p store.AddMessageParams) (store.Message, error) {
		return store.Message{
			ID:        uuid.New(),
			SessionID: p.SessionID,
			Role:      p.Role,
			Content:   p.Content,
			CreatedAt: now,
		}, nil
	}}
	handler := newTestRouter(t, st)

	rec := doRequest(t, handler, http.MethodPost, "/v1/sessions/"+sessionID.String()+"/messages",
		map[string]string{"role": "user", "content": "hello"}, authorized())
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201, body=%s", rec.Code, rec.Body.String())
	}
	got := decodeBody[messageResponse](t, rec)
	if got.SessionID != sessionID || got.Role != "user" || got.Content != "hello" {
		t.Errorf("message = %+v", got)
	}

	badRole := doRequest(t, handler, http.MethodPost, "/v1/sessions/"+sessionID.String()+"/messages",
		map[string]string{"role": "robot", "content": "hi"}, authorized())
	if badRole.Code != http.StatusUnprocessableEntity {
		t.Fatalf("bad role status = %d, want 422", badRole.Code)
	}
	if code := errorCode(t, badRole); code != "invalid_role" {
		t.Errorf("code = %q, want invalid_role", code)
	}

	empty := doRequest(t, handler, http.MethodPost, "/v1/sessions/"+sessionID.String()+"/messages",
		map[string]string{"role": "user", "content": "  "}, authorized())
	if empty.Code != http.StatusUnprocessableEntity {
		t.Fatalf("empty content status = %d, want 422", empty.Code)
	}
	if code := errorCode(t, empty); code != "invalid_content" {
		t.Errorf("code = %q, want invalid_content", code)
	}
}

func TestAddMessageSessionGone(t *testing.T) {
	st := &stubStore{addMessage: func(context.Context, store.AddMessageParams) (store.Message, error) {
		return store.Message{}, store.ErrNotFound
	}}
	handler := newTestRouter(t, st)

	rec := doRequest(t, handler, http.MethodPost, "/v1/sessions/"+uuid.NewString()+"/messages",
		map[string]string{"role": "user", "content": "hello"}, authorized())
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

func TestCORSPreflight(t *testing.T) {
	handler := newTestRouter(t, &stubStore{})

	headers := map[string]string{
		"Origin":                         "http://localhost:5173",
		"Access-Control-Request-Method":  "POST",
		"Access-Control-Request-Headers": "authorization, content-type",
	}
	rec := doRequest(t, handler, http.MethodOptions, "/v1/sessions", nil, headers)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://localhost:5173" {
		t.Errorf("allow-origin = %q", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Methods"); got != corsMethods {
		t.Errorf("allow-methods = %q", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Headers"); got != corsAllowHeader {
		t.Errorf("allow-headers = %q", got)
	}

	nullOrigin := doRequest(t, handler, http.MethodOptions, "/v1/sessions", nil, map[string]string{
		"Origin":                        "null",
		"Access-Control-Request-Method": "GET",
	})
	if got := nullOrigin.Header().Get("Access-Control-Allow-Origin"); got != "null" {
		t.Errorf("null origin allow-origin = %q", got)
	}

	denied := doRequest(t, handler, http.MethodOptions, "/v1/sessions", nil, map[string]string{
		"Origin":                        "https://evil.example",
		"Access-Control-Request-Method": "GET",
	})
	if got := denied.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("disallowed origin allow-origin = %q, want empty", got)
	}
}
