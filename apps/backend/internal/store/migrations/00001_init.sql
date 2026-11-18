-- +goose Up
CREATE TABLE sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title text NOT NULL,
    model text NOT NULL DEFAULT '',
    access_mode text NOT NULL DEFAULT 'ask'
        CHECK (access_mode IN ('plan', 'ask', 'auto', 'full')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    role text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    content text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX messages_session_created_idx ON messages (session_id, created_at);

-- +goose Down
DROP TABLE messages;
DROP TABLE sessions;
