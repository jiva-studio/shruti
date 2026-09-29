package catalogdb

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// FoldSearchText folds a string into the form `tracks_search` indexes.
//
// `unicode61` folds case and strips Latin diacritics, but keeps Cyrillic `ё`
// as a letter of its own, so "учёные" would be unreachable by "ученые", the
// spelling most keyboards produce. It also deletes combining marks inside a
// word: a decomposed `й` would index as "и", and marks outside its diacritic
// table (a Devanagari matra) would cut the word apart. So Latin and Greek
// marks are dropped the way `unicode61` drops them, everything else is
// recomposed first so `й ё ї ў` survive as themselves, and whatever mark is
// left is removed without splitting the word.
//
// The mobile query builder folds identically, so both spellings of a query
// reach both spellings of a title.
func FoldSearchText(s string) string {
	var b strings.Builder
	latinOrGreek := false
	for _, r := range norm.NFD.String(s) {
		if unicode.Is(unicode.M, r) {
			if !latinOrGreek {
				b.WriteRune(r)
			}
			continue
		}
		latinOrGreek = unicode.Is(unicode.Latin, r) || unicode.Is(unicode.Greek, r)
		b.WriteRune(r)
	}
	unmarked := strings.Map(func(r rune) rune {
		if unicode.Is(unicode.M, r) {
			return -1
		}
		return r
	}, norm.NFC.String(b.String()))
	return yoFolder.Replace(unmarked)
}

var yoFolder = strings.NewReplacer("ё", "е", "Ё", "Е")

// ReindexTrackSearch replaces a track's `tracks_search` rows with ones built
// from its current state: a `title` row per variant and one `combined` row.
//
// The combined row concatenates every searchable token — titles, each
// reference as "<source> <tokens>" under its id, short and full name, the
// location and tag names in every language, and the date as year, year-month
// and day — because the mobile search ANDs prefixes within one row, so
// "BG 1974 2.13" must find source, year and verse on the same track.
func ReindexTrackSearch(ctx context.Context, tx *sql.Tx, trackID string) error {
	if _, err := tx.ExecContext(ctx, `DELETE FROM tracks_search WHERE track_id = ?`, trackID); err != nil {
		return fmt.Errorf("clear search rows of %s: %w", trackID, err)
	}
	titles, err := stringColumn(ctx, tx, `SELECT title FROM track_variants WHERE track_id = ?`, trackID)
	if err != nil {
		return fmt.Errorf("read titles of %s: %w", trackID, err)
	}
	for _, title := range titles {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO tracks_search (content, track_id, kind) VALUES (?, ?, 'title')`,
			FoldSearchText(title), trackID); err != nil {
			return fmt.Errorf("index title of %s: %w", trackID, err)
		}
	}

	refs, err := referenceSegments(ctx, tx, trackID)
	if err != nil {
		return err
	}
	locations, err := stringColumn(ctx, tx, `
		SELECT l.full_name
		FROM tracks t
		JOIN locations l ON l.id = t.location_id
		WHERE t.id = ? AND l.full_name != ''`, trackID)
	if err != nil {
		return fmt.Errorf("read locations of %s: %w", trackID, err)
	}
	tags, err := stringColumn(ctx, tx, `
		SELECT tg.full_name
		FROM track_tags tt
		JOIN tags tg ON tg.id = tt.tag_id
		WHERE tt.track_id = ? AND tg.full_name != ''`, trackID)
	if err != nil {
		return fmt.Errorf("read tags of %s: %w", trackID, err)
	}
	dates, err := dateSegments(ctx, tx, trackID)
	if err != nil {
		return err
	}

	parts := make([]string, 0, len(titles)+len(refs)+len(locations)+len(tags)+len(dates))
	parts = append(parts, titles...)
	parts = append(parts, refs...)
	parts = append(parts, locations...)
	parts = append(parts, tags...)
	parts = append(parts, dates...)
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO tracks_search (content, track_id, kind) VALUES (?, ?, 'combined')`,
		FoldSearchText(strings.Join(parts, " ")), trackID); err != nil {
		return fmt.Errorf("index combined row of %s: %w", trackID, err)
	}
	return nil
}

func referenceSegments(ctx context.Context, tx *sql.Tx, trackID string) ([]string, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT r.source_id, r.tokens, COALESCE(s.short_name, ''), COALESCE(s.full_name, '')
		FROM track_references r
		LEFT JOIN sources s ON s.id = r.source_id
		WHERE r.track_id = ?
		ORDER BY r.ref_idx, s.language`, trackID)
	if err != nil {
		return nil, fmt.Errorf("read references of %s: %w", trackID, err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var sourceID, tokens, shortName, fullName string
		if err := rows.Scan(&sourceID, &tokens, &shortName, &fullName); err != nil {
			return nil, fmt.Errorf("scan reference of %s: %w", trackID, err)
		}
		out = append(out, sourceID+" "+tokens)
		if shortName != "" {
			out = append(out, shortName+" "+tokens)
		}
		if fullName != "" {
			out = append(out, fullName+" "+tokens)
		}
	}
	return out, rows.Err()
}

// dateSegments indexes the year, the year-month and the day as whole tokens,
// so an AND-prefix query for "1974-10" matches that month rather than a 10
// elsewhere in the row.
func dateSegments(ctx context.Context, tx *sql.Tx, trackID string) ([]string, error) {
	var date sql.NullString
	err := tx.QueryRowContext(ctx, `SELECT date FROM tracks WHERE id = ?`, trackID).Scan(&date)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read date of %s: %w", trackID, err)
	}
	var out []string
	for _, n := range []int{4, 7, 10} {
		if len(date.String) >= n {
			out = append(out, date.String[:n])
		}
	}
	return out, nil
}
