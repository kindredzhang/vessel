// Package store is vessel's Postgres persistence layer.
package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotFound is returned when a requested row does not exist.
var ErrNotFound = errors.New("store: not found")

// Session is a coding-agent conversation container.
type Session struct {
	ID         uuid.UUID
	Title      string
	Model      string
	AccessMode string
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// Message is a single turn inside a session.
type Message struct {
	ID        uuid.UUID
	SessionID uuid.UUID
	Role      string
	Content   string
	CreatedAt time.Time
}

// CreateSessionParams describes a new session.
type CreateSessionParams struct {
	Title      string
	Model      string
	AccessMode string
}

// AddMessageParams describes a new message.
type AddMessageParams struct {
	SessionID uuid.UUID
	Role      string
	Content   string
}

// Store wraps a pgx connection pool.
type Store struct {
	pool *pgxpool.Pool
}

// New dials Postgres and verifies connectivity.
func New(ctx context.Context, databaseURL string) (*Store, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse database url: %w", err)
	}
	cfg.MaxConns = 10
	cfg.MaxConnLifetime = 30 * time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}

	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	return &Store{pool: pool}, nil
}

// Close releases all pooled connections.
func (s *Store) Close() {
	s.pool.Close()
}

// Ping checks database reachability.
func (s *Store) Ping(ctx context.Context) error {
	return s.pool.Ping(ctx)
}

// CreateSession inserts a session and returns the stored row.
func (s *Store) CreateSession(ctx context.Context, p CreateSessionParams) (Session, error) {
	const q = `
		INSERT INTO sessions (title, model, access_mode)
		VALUES ($1, $2, $3)
		RETURNING id, title, model, access_mode, created_at, updated_at`

	var out Session
	err := s.pool.QueryRow(ctx, q, p.Title, p.Model, p.AccessMode).
		Scan(&out.ID, &out.Title, &out.Model, &out.AccessMode, &out.CreatedAt, &out.UpdatedAt)
	if err != nil {
		return Session{}, fmt.Errorf("create session: %w", err)
	}
	return out, nil
}

// ListSessions returns the most recently updated sessions first.
func (s *Store) ListSessions(ctx context.Context, limit int) ([]Session, error) {
	const q = `
		SELECT id, title, model, access_mode, created_at, updated_at
		FROM sessions
		ORDER BY updated_at DESC
		LIMIT $1`

	rows, err := s.pool.Query(ctx, q, limit)
	if err != nil {
		return nil, fmt.Errorf("list sessions: %w", err)
	}
	defer rows.Close()

	sessions := make([]Session, 0, limit)
	for rows.Next() {
		var sess Session
		if err := rows.Scan(&sess.ID, &sess.Title, &sess.Model, &sess.AccessMode, &sess.CreatedAt, &sess.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan session: %w", err)
		}
		sessions = append(sessions, sess)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list sessions: %w", err)
	}
	return sessions, nil
}

// GetSession loads a session by id.
func (s *Store) GetSession(ctx context.Context, id uuid.UUID) (Session, error) {
	const q = `
		SELECT id, title, model, access_mode, created_at, updated_at
		FROM sessions
		WHERE id = $1`

	var out Session
	err := s.pool.QueryRow(ctx, q, id).
		Scan(&out.ID, &out.Title, &out.Model, &out.AccessMode, &out.CreatedAt, &out.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return Session{}, ErrNotFound
	}
	if err != nil {
		return Session{}, fmt.Errorf("get session: %w", err)
	}
	return out, nil
}

// DeleteSession removes a session and its messages (via ON DELETE CASCADE).
func (s *Store) DeleteSession(ctx context.Context, id uuid.UUID) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM sessions WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("delete session: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// AddMessage inserts a message and bumps the owning session's updated_at in
// one transaction, so ordering by activity stays exact.
func (s *Store) AddMessage(ctx context.Context, p AddMessageParams) (Message, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Message{}, fmt.Errorf("begin add message: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	const insert = `
		INSERT INTO messages (session_id, role, content)
		VALUES ($1, $2, $3)
		RETURNING id, session_id, role, content, created_at`

	var out Message
	err = tx.QueryRow(ctx, insert, p.SessionID, p.Role, p.Content).
		Scan(&out.ID, &out.SessionID, &out.Role, &out.Content, &out.CreatedAt)
	if err != nil {
		if isForeignKeyViolation(err) {
			return Message{}, ErrNotFound
		}
		return Message{}, fmt.Errorf("insert message: %w", err)
	}

	if _, err := tx.Exec(ctx, `UPDATE sessions SET updated_at = now() WHERE id = $1`, p.SessionID); err != nil {
		return Message{}, fmt.Errorf("touch session: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Message{}, fmt.Errorf("commit add message: %w", err)
	}
	return out, nil
}

// ListMessages returns a session's messages oldest first.
func (s *Store) ListMessages(ctx context.Context, sessionID uuid.UUID) ([]Message, error) {
	const q = `
		SELECT id, session_id, role, content, created_at
		FROM messages
		WHERE session_id = $1
		ORDER BY created_at ASC, id ASC`

	rows, err := s.pool.Query(ctx, q, sessionID)
	if err != nil {
		return nil, fmt.Errorf("list messages: %w", err)
	}
	defer rows.Close()

	messages := make([]Message, 0, 32)
	for rows.Next() {
		var msg Message
		if err := rows.Scan(&msg.ID, &msg.SessionID, &msg.Role, &msg.Content, &msg.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan message: %w", err)
		}
		messages = append(messages, msg)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list messages: %w", err)
	}
	return messages, nil
}

func isForeignKeyViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23503"
}
