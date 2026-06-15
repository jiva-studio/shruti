package sqlitecatalog

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/infra/sqliteutil"
)

// SetTrackTopics replaces a track's full topic set in one shot: the
// (topic_id → weight) map becomes the track's `track_topics` rows, dropping any
// previous assignment. Language-agnostic (topics hang on the track, not the
// variant). Floor/cap/top-K is the caller's concern; empty topic_ids are
// skipped. Mirrors SetCollectionTracks' replace semantics.
func (r *Repo) SetTrackTopics(ctx context.Context, trackID string, weights map[string]float64) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		return r.SetTrackTopicsImpl(ctx, trackID, weights)
	})
}

func (r *Repo) SetTrackTopicsImpl(ctx context.Context, trackID string, weights map[string]float64) error {
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx,
		`DELETE FROM track_topics WHERE track_id = ?`, trackID); err != nil {
		return fmt.Errorf("clear track_topics: %w", err)
	}
	for topicID, weight := range weights {
		if topicID == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO track_topics (track_id, topic_id, weight) VALUES (?, ?, ?)`,
			trackID, topicID, weight); err != nil {
			return fmt.Errorf("insert track_topic %q: %w", topicID, err)
		}
	}
	return tx.Commit()
}

// SetTopicCover records the cover key on every locale of a topic (the art is
// language-neutral) in one statement.
func (r *Repo) SetTopicCover(ctx context.Context, id, cover string) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		_, err := r.db.ExecContext(ctx, `UPDATE topics SET cover = ? WHERE id = ?`, cover, id)
		return err
	})
}

// GetTopicName returns a topic's full name in the requested language, falling
// back to en and then any available locale. ok=false when the topic is absent.
func (r *Repo) GetTopicName(ctx context.Context, id, language string) (string, bool, error) {
	for _, l := range []string{language, "en"} {
		if l == "" {
			continue
		}
		var name string
		err := r.db.QueryRowContext(ctx,
			`SELECT full_name FROM topics WHERE id = ? AND language = ?`, id, l).Scan(&name)
		if err == nil {
			return name, true, nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return "", false, err
		}
	}
	var name string
	err := r.db.QueryRowContext(ctx,
		`SELECT full_name FROM topics WHERE id = ? LIMIT 1`, id).Scan(&name)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return name, true, nil
}
