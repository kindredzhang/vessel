package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/vesselhq/vessel/apps/backend/internal/store"
)

const (
	defaultSessionTitle = "New session"
	defaultAccessMode   = "ask"
	defaultListLimit    = 100
	maxListLimit        = 200
)

var validAccessModes = map[string]struct{}{
	"plan": {},
	"ask":  {},
	"auto": {},
	"full": {},
}

var validMessageRoles = map[string]struct{}{
	"user":      {},
	"assistant": {},
	"system":    {},
	"tool":      {},
}

type sessionResponse struct {
	ID         uuid.UUID `json:"id"`
	Title      string    `json:"title"`
	Model      string    `json:"model"`
	AccessMode string    `json:"access_mode"`
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

type messageResponse struct {
	ID        uuid.UUID `json:"id"`
	SessionID uuid.UUID `json:"session_id"`
	Role      string    `json:"role"`
	Content   string    `json:"content"`
	CreatedAt time.Time `json:"created_at"`
}

type createSessionRequest struct {
	Title      string `json:"title"`
	Model      string `json:"model"`
	AccessMode string `json:"access_mode"`
}

type createMessageRequest struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

func toSessionResponse(s store.Session) sessionResponse {
	return sessionResponse{
		ID:         s.ID,
		Title:      s.Title,
		Model:      s.Model,
		AccessMode: s.AccessMode,
		CreatedAt:  s.CreatedAt,
		UpdatedAt:  s.UpdatedAt,
	}
}

func toMessageResponse(m store.Message) messageResponse {
	return messageResponse{
		ID:        m.ID,
		SessionID: m.SessionID,
		Role:      m.Role,
		Content:   m.Content,
		CreatedAt: m.CreatedAt,
	}
}

func (s *server) createSession(w http.ResponseWriter, r *http.Request) {
	var req createSessionRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", err.Error())
		return
	}

	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = defaultSessionTitle
	}
	accessMode := strings.TrimSpace(req.AccessMode)
	if accessMode == "" {
		accessMode = defaultAccessMode
	}
	if _, ok := validAccessModes[accessMode]; !ok {
		writeError(w, http.StatusUnprocessableEntity, "invalid_access_mode",
			"access_mode must be one of plan, ask, auto, full")
		return
	}

	session, err := s.store.CreateSession(r.Context(), store.CreateSessionParams{
		Title:      title,
		Model:      strings.TrimSpace(req.Model),
		AccessMode: accessMode,
	})
	if err != nil {
		s.internalError(w, r, "create session", err)
		return
	}

	w.Header().Set("Location", "/v1/sessions/"+session.ID.String())
	writeJSON(w, http.StatusCreated, toSessionResponse(session))
}

func (s *server) listSessions(w http.ResponseWriter, r *http.Request) {
	limit := defaultListLimit
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > maxListLimit {
			writeError(w, http.StatusBadRequest, "invalid_limit", "limit must be an integer between 1 and 200")
			return
		}
		limit = parsed
	}

	sessions, err := s.store.ListSessions(r.Context(), limit)
	if err != nil {
		s.internalError(w, r, "list sessions", err)
		return
	}

	out := make([]sessionResponse, 0, len(sessions))
	for _, session := range sessions {
		out = append(out, toSessionResponse(session))
	}
	writeJSON(w, http.StatusOK, map[string]any{"sessions": out})
}

func (s *server) getSession(w http.ResponseWriter, r *http.Request) {
	id, ok := sessionID(w, r)
	if !ok {
		return
	}

	session, err := s.store.GetSession(r.Context(), id)
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "session not found")
	case err != nil:
		s.internalError(w, r, "get session", err)
	default:
		writeJSON(w, http.StatusOK, toSessionResponse(session))
	}
}

func (s *server) deleteSession(w http.ResponseWriter, r *http.Request) {
	id, ok := sessionID(w, r)
	if !ok {
		return
	}

	err := s.store.DeleteSession(r.Context(), id)
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "session not found")
	case err != nil:
		s.internalError(w, r, "delete session", err)
	default:
		w.WriteHeader(http.StatusNoContent)
	}
}

func (s *server) addMessage(w http.ResponseWriter, r *http.Request) {
	id, ok := sessionID(w, r)
	if !ok {
		return
	}

	var req createMessageRequest
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json", err.Error())
		return
	}
	if _, ok := validMessageRoles[req.Role]; !ok {
		writeError(w, http.StatusUnprocessableEntity, "invalid_role",
			"role must be one of user, assistant, system, tool")
		return
	}
	if strings.TrimSpace(req.Content) == "" {
		writeError(w, http.StatusUnprocessableEntity, "invalid_content", "content must not be empty")
		return
	}

	message, err := s.store.AddMessage(r.Context(), store.AddMessageParams{
		SessionID: id,
		Role:      req.Role,
		Content:   req.Content,
	})
	switch {
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "not_found", "session not found")
	case err != nil:
		s.internalError(w, r, "add message", err)
	default:
		writeJSON(w, http.StatusCreated, toMessageResponse(message))
	}
}

func (s *server) listMessages(w http.ResponseWriter, r *http.Request) {
	id, ok := sessionID(w, r)
	if !ok {
		return
	}

	messages, err := s.store.ListMessages(r.Context(), id)
	if err != nil {
		s.internalError(w, r, "list messages", err)
		return
	}

	out := make([]messageResponse, 0, len(messages))
	for _, message := range messages {
		out = append(out, toMessageResponse(message))
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": out})
}

// sessionID parses the {id} path parameter, writing a 400 when malformed.
func sessionID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_id", "session id must be a valid uuid")
		return uuid.Nil, false
	}
	return id, true
}

func (s *server) internalError(w http.ResponseWriter, r *http.Request, op string, err error) {
	s.logger.Error("request failed", "op", op, "error", err, "path", r.URL.Path)
	writeError(w, http.StatusInternalServerError, "internal", "internal server error")
}
