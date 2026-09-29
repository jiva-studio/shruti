package sqlitecatalog

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/jiva-studio/shruti/catalogdb"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
)

// SaveTrack performs the atomic UPSERT for tracks + track_variants +
// track_references and the track's search rows.
func (r *Repo) SaveTrackImpl(ctx context.Context, t catalog.TrackRow, v catalog.VariantRow, audios []catalog.AudioRow, refs []catalog.TrackReference) error {
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
	_, err = tx.ExecContext(ctx, `
		INSERT INTO tracks (id, author_id, location_id, date, hidden, contributor_user_id)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			author_id           = excluded.author_id,
			location_id         = excluded.location_id,
			date                = excluded.date,
			hidden              = excluded.hidden,
			contributor_user_id = COALESCE(excluded.contributor_user_id, contributor_user_id)`,
		t.ID, t.AuthorID, t.LocationID, t.Date, hidden,
		sql.NullString{String: t.ContributorUserID, Valid: t.ContributorUserID != ""})
	if err != nil {
		return fmt.Errorf("upsert tracks: %w", err)
	}

	_, err = tx.ExecContext(ctx, `
		INSERT INTO track_variants (track_id, language, title,
			transcript_path, transcript_kind, sort_reference, outline, description)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(track_id, language) DO UPDATE SET
			title           = excluded.title,
			transcript_path = excluded.transcript_path,
			transcript_kind = excluded.transcript_kind,
			sort_reference  = excluded.sort_reference,
			outline         = COALESCE(excluded.outline, outline),
			description     = COALESCE(excluded.description, description)`,
		v.TrackID, v.Language, v.Title, v.TranscriptPath, v.TranscriptKind, v.SortReference,
		sql.NullString{String: v.Outline, Valid: v.Outline != ""},
		sql.NullString{String: v.Description, Valid: v.Description != ""})
	if err != nil {
		return fmt.Errorf("upsert track_variants: %w", err)
	}

	// Record the transcript's content hash so the chat indexer can discover +
	// diff it from the published current.db instead of listing S3 (Bunny has no
	// anonymous listing). Keyed by public path.
	//
	// No hash means this variant has no transcript to advertise, so any row
	// left from an earlier state has to go: the indexer treats every
	// `asset_hashes` row as "this file is on the CDN" and retries the fetch
	// on every run forever when it isn't.
	if v.TranscriptSHA256 != "" && v.TranscriptPath != "" {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO asset_hashes (path, sha256, track_id, language, kind)
			VALUES (?, ?, ?, ?, 'transcript')
			ON CONFLICT(path) DO UPDATE SET
				sha256   = excluded.sha256,
				track_id = excluded.track_id,
				language = excluded.language,
				kind     = excluded.kind`,
			v.TranscriptPath, v.TranscriptSHA256, v.TrackID, v.Language); err != nil {
			return fmt.Errorf("upsert asset_hashes: %w", err)
		}
	} else if _, err := tx.ExecContext(ctx,
		`DELETE FROM asset_hashes WHERE track_id = ? AND language = ? AND kind = 'transcript'`,
		v.TrackID, v.Language); err != nil {
		return fmt.Errorf("clear asset_hashes: %w", err)
	}

	// Replace this variant's audio versions in full.
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM track_audio WHERE track_id = ? AND language = ?`,
		v.TrackID, v.Language); err != nil {
		return fmt.Errorf("delete track_audio: %w", err)
	}
	for _, a := range audios {
		if a.Path == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO track_audio (track_id, language, kind, path, filesize, duration)
			VALUES (?, ?, ?, ?, ?, ?)`,
			a.TrackID, a.Language, a.Kind, a.Path, a.Filesize, a.Duration); err != nil {
			return fmt.Errorf("insert track_audio[%s]: %w", a.Kind, err)
		}
	}

	// Replace track_references in full.
	if _, err := tx.ExecContext(ctx, `DELETE FROM track_references WHERE track_id = ?`, t.ID); err != nil {
		return fmt.Errorf("delete track_references: %w", err)
	}
	for i, ref := range refs {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO track_references (track_id, ref_idx, source_id, tokens)
			VALUES (?, ?, ?, ?)`,
			t.ID, i, ref.SourceID, ref.Tokens); err != nil {
			return fmt.Errorf("insert track_references[%d]: %w", i, err)
		}
	}

	// Replace track_tags in full. Track-level kind tags (morning_walk,
	// conversation, …) live in the canonical join table; track_variants
	// has nothing to do with them.
	if _, err := tx.ExecContext(ctx, `DELETE FROM track_tags WHERE track_id = ?`, t.ID); err != nil {
		return fmt.Errorf("delete track_tags: %w", err)
	}
	for _, tagID := range t.TagIDs {
		if tagID == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO track_tags (track_id, tag_id) VALUES (?, ?)
			 ON CONFLICT(track_id, tag_id) DO NOTHING`,
			t.ID, tagID); err != nil {
			return fmt.Errorf("insert track_tags: %w", err)
		}
	}

	if err := catalogdb.ReindexTrackSearch(ctx, tx, t.ID); err != nil {
		return fmt.Errorf("reindex search: %w", err)
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

	// track_audio is FK ON DELETE CASCADE off track_variants, but delete it
	// explicitly too — matching the sibling child tables below and not relying
	// on PRAGMA foreign_keys being on for this connection.
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM track_audio WHERE track_id = ? AND language = ?`,
		trackID, language); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM track_variants WHERE track_id = ? AND language = ?`,
		trackID, language); err != nil {
		return err
	}
	// asset_hashes is keyed by public path, not by the variant, so nothing
	// cascades. A row surviving its variant keeps the published catalog
	// advertising a transcript nobody can fetch.
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM asset_hashes WHERE track_id = ? AND language = ?`,
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
	} else if err := catalogdb.ReindexTrackSearch(ctx, tx, trackID); err != nil {
		return fmt.Errorf("reindex search: %w", err)
	}
	return tx.Commit()
}
