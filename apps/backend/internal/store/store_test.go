package store

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
)

// testDatabaseURL returns DATABASE_URL or skips the test. Store tests need a
// real Postgres; the HTTP tests cover everything that does not.
func testDatabaseURL(t *testing.T) string {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL is not set; skipping Postgres-backed test")
	}
	return url
}

func newTestStore(t *testing.T) *Store {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	st, err := New(ctx, testDatabaseURL(t))
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(st.Close)
	return st
}

func TestMigrate(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	url := testDatabaseURL(t)
	// Migrate is idempotent, so running it twice is the smoke test.
	for i := 0; i < 2; i++ {
		if err := Migrate(ctx, url); err != nil {
			t.Fatalf("migrate (run %d): %v", i+1, err)
		}
	}

	st := newTestStore(t)
	if _, err := st.ListSessions(ctx, 1); err != nil {
		t.Fatalf("query after migrate: %v", err)
	}
}

func TestMissingSessionReturnsErrNotFound(t *testing.T) {
	st := newTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	missing := uuid.New()

	if _, err := st.GetSession(ctx, missing); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetSession err = %v, want ErrNotFound", err)
	}
	if err := st.DeleteSession(ctx, missing); !errors.Is(err, ErrNotFound) {
		t.Errorf("DeleteSession err = %v, want ErrNotFound", err)
	}
	if _, err := st.AddMessage(ctx, AddMessageParams{SessionID: missing, Role: "user", Content: "hi"}); !errors.Is(err, ErrNotFound) {
		t.Errorf("AddMessage err = %v, want ErrNotFound", err)
	}
	if _, err := st.GetSession(ctx, uuid.Nil); !errors.Is(err, ErrNotFound) {
		t.Errorf("GetSession(nil) err = %v, want ErrNotFound", err)
	}
}

func TestSessionRoundTrip(t *testing.T) {
	st := newTestStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	session, err := st.CreateSession(ctx, CreateSessionParams{Title: "round trip", Model: "vessel-1", AccessMode: "auto"})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	t.Cleanup(func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = st.DeleteSession(cleanupCtx, session.ID)
	})

	if session.Title != "round trip" || session.AccessMode != "auto" {
		t.Fatalf("session = %+v", session)
	}

	msg, err := st.AddMessage(ctx, AddMessageParams{SessionID: session.ID, Role: "user", Content: "hello"})
	if err != nil {
		t.Fatalf("add message: %v", err)
	}
	if msg.SessionID != session.ID || msg.Content != "hello" {
		t.Fatalf("message = %+v", msg)
	}

	updated, err := st.GetSession(ctx, session.ID)
	if err != nil {
		t.Fatalf("get session: %v", err)
	}
	if !updated.UpdatedAt.After(session.UpdatedAt) && !updated.UpdatedAt.Equal(session.UpdatedAt) {
		t.Errorf("updated_at = %v, want >= %v", updated.UpdatedAt, session.UpdatedAt)
	}

	messages, err := st.ListMessages(ctx, session.ID)
	if err != nil {
		t.Fatalf("list messages: %v", err)
	}
	if len(messages) != 1 || messages[0].ID != msg.ID {
		t.Fatalf("messages = %+v", messages)
	}

	sessions, err := st.ListSessions(ctx, 100)
	if err != nil {
		t.Fatalf("list sessions: %v", err)
	}
	if len(sessions) == 0 || sessions[0].ID != session.ID {
		t.Errorf("session not first in list: %+v", sessions)
	}

	if err := st.DeleteSession(ctx, session.ID); err != nil {
		t.Fatalf("delete session: %v", err)
	}
	if _, err := st.GetSession(ctx, session.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("get after delete err = %v, want ErrNotFound", err)
	}
}
