package sqlitecatalog

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
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
	_, err = tx.ExecContext(ctx, `
		INSERT INTO tracks (id, author_id, location_id, date, hidden)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			author_id      = excluded.author_id,
			location_id    = excluded.location_id,
			date           = excluded.date,
			hidden         = excluded.hidden`,
		t.Id, t.AuthorID, t.LocationID, t.Date, hidden)
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

	// FTS rebuild — drop every prior row for this track, then re-emit:
	//   - one `title` row per stored variant (back-compat with existing
	//     consumers that filter by kind)
	//   - one `combined` row that mashes title + reference variants
	//     (source_id / short_name / full_name) + year into a single
	//     space-separated content column. The mobile search path joins
	//     on `kind = 'combined'` so an implicit-AND multi-token query
	//     like "BG 1974 2.13" can match across fields.
	if _, err := tx.ExecContext(ctx, `DELETE FROM tracks_search WHERE track_id = ?`, t.Id); err != nil {
		return fmt.Errorf("delete tracks_search: %w", err)
	}
	if err := rebuildTrackSearchRows(ctx, tx, t.Id); err != nil {
		return fmt.Errorf("rebuild tracks_search: %w", err)
	}

	return tx.Commit()
}

// rebuildTrackSearchRows recomputes both `title` and `combined` FTS rows
// for one track from the current state of tracks / track_variants /
// track_references / sources inside the open transaction. Caller is
// responsible for having cleared prior rows for this track.
func rebuildTrackSearchRows(ctx context.Context, tx *sql.Tx, trackID string) error {
	// One `title` row per stored variant.
	titleRows, err := tx.QueryContext(ctx,
		`SELECT title FROM track_variants WHERE track_id = ?`, trackID)
	if err != nil {
		return fmt.Errorf("read titles: %w", err)
	}
	var titles []string
	for titleRows.Next() {
		var title string
		if err := titleRows.Scan(&title); err != nil {
			titleRows.Close()
			return fmt.Errorf("scan title: %w", err)
		}
		titles = append(titles, title)
	}
	titleRows.Close()
	for _, title := range titles {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO tracks_search (content, track_id, kind)
			VALUES (?, ?, 'title')`, title, trackID); err != nil {
			return fmt.Errorf("insert title row: %w", err)
		}
	}

	// `combined` row — every searchable token concatenated, space-
	// separated. Mobile search ANDs prefixes within this row so a
	// query like "BG 1974 2.13" hits source short_name (BG), year
	// (1974), and a reference token (2.13) on the same track.
	refRows, err := tx.QueryContext(ctx, `
		SELECT r.source_id, r.tokens, COALESCE(s.short_name, ''), COALESCE(s.full_name, '')
		FROM track_references r
		LEFT JOIN sources s ON s.id = r.source_id
		WHERE r.track_id = ?
		ORDER BY r.ref_idx, s.language`, trackID)
	if err != nil {
		return fmt.Errorf("read references: %w", err)
	}
	var refSegs []string
	for refRows.Next() {
		var sourceID, tokens, shortName, fullName string
		if err := refRows.Scan(&sourceID, &tokens, &shortName, &fullName); err != nil {
			refRows.Close()
			return fmt.Errorf("scan reference: %w", err)
		}
		refSegs = append(refSegs, sourceID+" "+tokens)
		if shortName != "" {
			refSegs = append(refSegs, shortName+" "+tokens)
		}
		if fullName != "" {
			refSegs = append(refSegs, fullName+" "+tokens)
		}
	}
	refRows.Close()

	// Location names (per language) so free-text queries like "Bombay"
	// or "Бомбей" hit tracks recorded there without needing the chip.
	locRows, err := tx.QueryContext(ctx, `
		SELECT COALESCE(l.full_name, '')
		FROM tracks t
		LEFT JOIN locations l ON l.id = t.location_id
		WHERE t.id = ? AND t.location_id IS NOT NULL AND t.location_id != ''`,
		trackID)
	if err != nil {
		return fmt.Errorf("read locations: %w", err)
	}
	var locNames []string
	for locRows.Next() {
		var name string
		if err := locRows.Scan(&name); err != nil {
			locRows.Close()
			return fmt.Errorf("scan location: %w", err)
		}
		if name != "" {
			locNames = append(locNames, name)
		}
	}
	locRows.Close()

	// Tag names (per language) — kind-tags like "morning walk" /
	// "интервью" become findable as plain free text. Tracks are
	// language-independent entities, so we index every language we
	// have on file, not just the active UI locale.
	tagRows, err := tx.QueryContext(ctx, `
		SELECT tg.full_name
		FROM track_tags tt
		JOIN tags tg ON tg.id = tt.tag_id
		WHERE tt.track_id = ? AND tg.full_name != ''`,
		trackID)
	if err != nil {
		return fmt.Errorf("read tags: %w", err)
	}
	var tagNames []string
	for tagRows.Next() {
		var name string
		if err := tagRows.Scan(&name); err != nil {
			tagRows.Close()
			return fmt.Errorf("scan tag: %w", err)
		}
		tagNames = append(tagNames, name)
	}
	tagRows.Close()

	// Date — year alone, plus YYYY-MM and the full YYYY-MM-DD, so a
	// query like "1974-10" or "1974-10-20" matches the precise day.
	// The FTS tokenizer splits on `-`, so each component becomes its
	// own searchable token; we add the composite forms so an
	// AND-prefix match (`1974* 10*`) doesn't false-positive on
	// unrelated tokens elsewhere.
	var date string
	row := tx.QueryRowContext(ctx, `SELECT date FROM tracks WHERE id = ?`, trackID)
	_ = row.Scan(&date)
	var dateParts []string
	if len(date) >= 4 {
		dateParts = append(dateParts, date[:4]) // year
	}
	if len(date) >= 7 {
		dateParts = append(dateParts, date[:7]) // year-month
	}
	if len(date) >= 10 {
		dateParts = append(dateParts, date[:10]) // full date
	}

	parts := make([]string, 0, len(titles)+len(refSegs)+len(locNames)+len(tagNames)+len(dateParts))
	parts = append(parts, titles...)
	parts = append(parts, refSegs...)
	parts = append(parts, locNames...)
	parts = append(parts, tagNames...)
	parts = append(parts, dateParts...)
	combined := strings.Join(parts, " ")
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO tracks_search (content, track_id, kind)
		VALUES (?, ?, 'combined')`, combined, trackID); err != nil {
		return fmt.Errorf("insert combined row: %w", err)
	}
	return nil
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
