// Package state is the service's own small SQLite store: a log of what was
// posted (powers the not-recently-posted filter and idempotent reruns) and
// the VK wisdom→audio id mapping for the optional attach-audio strategy.
package state

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite" // pure-Go driver (CGO_ENABLED=0 build)
)

type State struct {
	db *sql.DB
}

const schema = `
CREATE TABLE IF NOT EXISTS posts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign    TEXT NOT NULL,
  content_id  TEXT NOT NULL,
  target      TEXT NOT NULL,
  posted_at   INTEGER NOT NULL,
  ref         TEXT
);
CREATE INDEX IF NOT EXISTS idx_posts_content ON posts(content_id, posted_at);
CREATE INDEX IF NOT EXISTS idx_posts_target  ON posts(target, content_id, posted_at);

CREATE TABLE IF NOT EXISTS vk_audio_map (
  wisdom_id TEXT PRIMARY KEY,
  owner_id  TEXT NOT NULL,
  audio_id  TEXT NOT NULL
);
`

// Open opens (creating if needed) the state DB at path and applies schema.
func Open(path string) (*State, error) {
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("mkdir state dir: %w", err)
		}
	}
	db, err := sql.Open("sqlite", fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)", path))
	if err != nil {
		return nil, fmt.Errorf("open state db: %w", err)
	}
	if _, err := db.ExecContext(context.Background(), schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("apply schema: %w", err)
	}
	return &State{db: db}, nil
}

func (s *State) Close() error { return s.db.Close() }

// Record logs one successful publish.
func (s *State) Record(ctx context.Context, campaign, contentID, target, ref string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO posts(campaign, content_id, target, posted_at, ref) VALUES(?,?,?,?,?)`,
		campaign, contentID, target, time.Now().Unix(), ref)
	if err != nil {
		return fmt.Errorf("record post: %w", err)
	}
	return nil
}

// PostedWithin returns the set of content ids posted anywhere in the last
// `days` days. days<=0 → empty set (filter disabled). Used to skip content
// that ran recently so campaigns don't repeat themselves.
func (s *State) PostedWithin(ctx context.Context, days int) (map[string]struct{}, error) {
	out := map[string]struct{}{}
	if days <= 0 {
		return out, nil
	}
	cutoff := time.Now().Add(-time.Duration(days) * 24 * time.Hour).Unix()
	rows, err := s.db.QueryContext(ctx,
		`SELECT DISTINCT content_id FROM posts WHERE posted_at >= ?`, cutoff)
	if err != nil {
		return nil, fmt.Errorf("query posted_within: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = struct{}{}
	}
	return out, rows.Err()
}

// AlreadyPosted reports whether this exact (content, target) pair was ever
// posted — a hard idempotency guard independent of the day window.
func (s *State) AlreadyPosted(ctx context.Context, contentID, target string) (bool, error) {
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(1) FROM posts WHERE content_id=? AND target=?`, contentID, target).Scan(&n)
	if err != nil {
		return false, fmt.Errorf("check already_posted: %w", err)
	}
	return n > 0, nil
}

// VKAudioRef returns the "audio{owner}_{id}" attachment string for a wisdom
// id, or ("", false) if unmapped.
func (s *State) VKAudioRef(ctx context.Context, wisdomID string) (string, bool) {
	var owner, audio string
	err := s.db.QueryRowContext(ctx,
		`SELECT owner_id, audio_id FROM vk_audio_map WHERE wisdom_id=?`, wisdomID).Scan(&owner, &audio)
	if err != nil {
		return "", false
	}
	return fmt.Sprintf("audio%s_%s", owner, audio), true
}

// SetVKAudio upserts a wisdom→audio mapping (used by the one-time reconcile).
func (s *State) SetVKAudio(ctx context.Context, wisdomID, ownerID, audioID string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO vk_audio_map(wisdom_id, owner_id, audio_id) VALUES(?,?,?)
		 ON CONFLICT(wisdom_id) DO UPDATE SET owner_id=excluded.owner_id, audio_id=excluded.audio_id`,
		wisdomID, ownerID, audioID)
	if err != nil {
		return fmt.Errorf("set vk_audio: %w", err)
	}
	return nil
}
