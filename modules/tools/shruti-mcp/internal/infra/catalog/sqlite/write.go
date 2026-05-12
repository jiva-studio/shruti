package sqlitecatalog

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
)

// SaveTrack performs the atomic UPSERT for tracks + track_variants +
// track_references + tracks_search FTS row. Replaces ErrReadOnly stub.
func (r *Repo) SaveTrackImpl(ctx context.Context, t catalog.TrackRow, v catalog.VariantRow, refs []catalog.TrackReference) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if err := assertExists(ctx, tx, "authors", t.AuthorID); err != nil {
		return err
	}
	if t.LocationID != "" {
		if err := assertExists(ctx, tx, "locations", t.LocationID); err != nil {
			return err
		}
	}
	for _, ref := range refs {
		if err := assertExists(ctx, tx, "sources", ref.SourceID); err != nil {
			return err
		}
	}

	hidden := 0
	if t.Hidden {
		hidden = 1
	}
	// tracks.sort_reference is a wire-schema legacy column; we no longer
	// populate it (the per-locale sort key lives on track_variants). Pass
	// '' so the NOT NULL constraint stays happy on the legacy column for
	// existing readers; new writers ignore it. tracks.sort_date stays.
	_, err = tx.ExecContext(ctx, `
		INSERT INTO tracks (id, author_id, location_id, date, hidden, sort_reference, sort_date)
		VALUES (?, ?, ?, ?, ?, '', ?)
		ON CONFLICT(id) DO UPDATE SET
			author_id      = excluded.author_id,
			location_id    = excluded.location_id,
			date           = excluded.date,
			hidden         = excluded.hidden,
			sort_date      = excluded.sort_date`,
		t.Id, t.AuthorID, t.LocationID, t.Date, hidden, t.SortDate)
	if err != nil {
		return fmt.Errorf("upsert tracks: %w", err)
	}

	_, err = tx.ExecContext(ctx, `
		INSERT INTO track_variants (track_id, language, title, audio_path, audio_filesize,
			audio_duration, audio_kind, transcript_path, transcript_kind, sort_reference)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(track_id, language) DO UPDATE SET
			title           = excluded.title,
			audio_path      = excluded.audio_path,
			audio_filesize  = excluded.audio_filesize,
			audio_duration  = excluded.audio_duration,
			audio_kind      = excluded.audio_kind,
			transcript_path = excluded.transcript_path,
			transcript_kind = excluded.transcript_kind,
			sort_reference  = excluded.sort_reference`,
		v.TrackID, v.Language, v.Title, v.AudioPath, v.AudioFilesize,
		v.AudioDuration, v.AudioKind, v.TranscriptPath, v.TranscriptKind, v.SortReference)
	if err != nil {
		return fmt.Errorf("upsert track_variants: %w", err)
	}

	// Replace track_references in full.
	if _, err := tx.ExecContext(ctx, `DELETE FROM track_references WHERE track_id = ?`, t.Id); err != nil {
		return fmt.Errorf("delete track_references: %w", err)
	}
	for i, ref := range refs {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO track_references (track_id, ref_idx, source_id, tokens)
			VALUES (?, ?, ?, ?)`,
			t.Id, i, ref.SourceID, ref.Tokens); err != nil {
			return fmt.Errorf("insert track_references[%d]: %w", i, err)
		}
	}

	// Replace track_tags in full. Track-level kind tags (morning_walk,
	// conversation, …) live in the canonical join table; track_variants
	// has nothing to do with them.
	if _, err := tx.ExecContext(ctx, `DELETE FROM track_tags WHERE track_id = ?`, t.Id); err != nil {
		return fmt.Errorf("delete track_tags: %w", err)
	}
	for _, tagID := range t.TagIDs {
		if tagID == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO track_tags (track_id, tag_id) VALUES (?, ?)
			 ON CONFLICT(track_id, tag_id) DO NOTHING`,
			t.Id, tagID); err != nil {
			return fmt.Errorf("insert track_tags: %w", err)
		}
	}

	// FTS title row — delete any prior rows for this track and re-insert.
	if _, err := tx.ExecContext(ctx, `DELETE FROM tracks_search WHERE track_id = ?`, t.Id); err != nil {
		return fmt.Errorf("delete tracks_search: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO tracks_search (content, track_id, kind)
		VALUES (?, ?, 'title')`,
		v.Title, t.Id); err != nil {
		return fmt.Errorf("insert tracks_search: %w", err)
	}

	return tx.Commit()
}

func assertExists(ctx context.Context, tx *sql.Tx, table, id string) error {
	if id == "" {
		return fmt.Errorf("%s id required", table)
	}
	row := tx.QueryRowContext(ctx, fmt.Sprintf(`SELECT 1 FROM %s WHERE id = ? LIMIT 1`, table), id)
	var n int
	if err := row.Scan(&n); err != nil {
		return fmt.Errorf("%s.id=%s not found", table, id)
	}
	return nil
}

// DeleteTrackVariantImpl removes one (track, language) variant. Removes the
// tracks row + references when the last variant is gone.
func (r *Repo) DeleteTrackVariantImpl(ctx context.Context, trackID, language string) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx,
		`DELETE FROM track_variants WHERE track_id = ? AND language = ?`,
		trackID, language); err != nil {
		return err
	}
	row := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM track_variants WHERE track_id = ?`, trackID)
	var n int
	if err := row.Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		if _, err := tx.ExecContext(ctx, `DELETE FROM track_references WHERE track_id = ?`, trackID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM tracks_search WHERE track_id = ?`, trackID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM tracks WHERE id = ?`, trackID); err != nil {
			return err
		}
	}
	return tx.Commit()
}
