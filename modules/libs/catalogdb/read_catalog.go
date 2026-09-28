package catalogdb

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// Querier is what a read needs: *sql.DB, *sql.Conn and *sql.Tx all satisfy it,
// over either SQLite driver.
type Querier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// Track is one row of `tracks`.
type Track struct {
	ID                string
	AuthorID          string
	LocationID        string
	Date              string
	Hidden            bool
	ContributorUserID string
}

// Variant is one language of a track, from `track_variants`.
type Variant struct {
	TrackID        string
	Language       string
	Title          string
	TranscriptPath string
	Outline        string
	Description    string
}

// Reference is one entry of `track_references`, in the track's order.
type Reference struct {
	SourceID string
	Tokens   string
}

// DictRow is one language of a dictionary entry. ShortName is set for the
// dictionaries that carry one (sources, topics).
type DictRow struct {
	ID        string
	Language  string
	FullName  string
	ShortName string
}

// Dict names a catalog dictionary table.
type Dict string

const (
	DictAuthors   Dict = "authors"
	DictLocations Dict = "locations"
	DictSources   Dict = "sources"
	DictTags      Dict = "tags"
	DictTopics    Dict = "topics"
)

// DictRows returns every row of a dictionary ordered by id then language.
func DictRows(ctx context.Context, q Querier, d Dict) ([]DictRow, error) {
	var cols string
	switch d {
	case DictSources, DictTopics:
		cols = "id, language, full_name, COALESCE(short_name, '')"
	case DictAuthors, DictLocations, DictTags:
		cols = "id, language, full_name, ''"
	default:
		return nil, fmt.Errorf("unknown dictionary %q", d)
	}
	// Both identifiers come from the switch above, never from input.
	rows, err := q.QueryContext(ctx,
		fmt.Sprintf(`SELECT %s FROM %s ORDER BY id, language`, cols, d))
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", d, err)
	}
	defer rows.Close()
	var out []DictRow
	for rows.Next() {
		var r DictRow
		if err := rows.Scan(&r.ID, &r.Language, &r.FullName, &r.ShortName); err != nil {
			return nil, fmt.Errorf("scan %s: %w", d, err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// TrackByID returns one track, and false when there is none.
func TrackByID(ctx context.Context, q Querier, id string) (Track, bool, error) {
	var (
		t                                   Track
		author, location, date, contributor sql.NullString
		hidden                              int
	)
	err := q.QueryRowContext(ctx,
		`SELECT id, author_id, location_id, date, hidden, contributor_user_id FROM tracks WHERE id = ?`, id).
		Scan(&t.ID, &author, &location, &date, &hidden, &contributor)
	if errors.Is(err, sql.ErrNoRows) {
		return Track{}, false, nil
	}
	if err != nil {
		return Track{}, false, fmt.Errorf("read track %s: %w", id, err)
	}
	t.AuthorID, t.LocationID, t.Date = author.String, location.String, date.String
	t.Hidden = hidden != 0
	t.ContributorUserID = contributor.String
	return t, true, nil
}

// VariantsOf returns the variants of each track, ordered by language.
func VariantsOf(ctx context.Context, q Querier, trackIDs []string) (map[string][]Variant, error) {
	out := map[string][]Variant{}
	err := eachChunk(trackIDs, func(ids []string, ph string) error {
		rows, err := q.QueryContext(ctx,
			`SELECT track_id, language, title, transcript_path, outline, description
			 FROM track_variants WHERE track_id IN (`+ph+`) ORDER BY track_id, language`,
			anySlice(ids)...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var (
				v                                 Variant
				transcript, outline, description sql.NullString
			)
			if err := rows.Scan(&v.TrackID, &v.Language, &v.Title, &transcript, &outline, &description); err != nil {
				return err
			}
			v.TranscriptPath, v.Outline, v.Description = transcript.String, outline.String, description.String
			out[v.TrackID] = append(out[v.TrackID], v)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, fmt.Errorf("read variants: %w", err)
	}
	return out, nil
}

// AudioDurationsOf returns each track's audio length in milliseconds per
// language. Every audio kind of a variant has the same length (a clean track
// is the denoised original), so the longest row answers.
func AudioDurationsOf(ctx context.Context, q Querier, trackIDs []string) (map[string]map[string]int64, error) {
	out := map[string]map[string]int64{}
	err := eachChunk(trackIDs, func(ids []string, ph string) error {
		rows, err := q.QueryContext(ctx,
			`SELECT track_id, language, MAX(duration) FROM track_audio
			 WHERE track_id IN (`+ph+`) AND duration > 0 GROUP BY track_id, language`,
			anySlice(ids)...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var (
				id, lang string
				dur      int64
			)
			if err := rows.Scan(&id, &lang, &dur); err != nil {
				return err
			}
			if out[id] == nil {
				out[id] = map[string]int64{}
			}
			out[id][lang] = dur
		}
		return rows.Err()
	})
	if err != nil {
		return nil, fmt.Errorf("read audio durations: %w", err)
	}
	return out, nil
}

// TagsOf returns the tag ids of each track.
func TagsOf(ctx context.Context, q Querier, trackIDs []string) (map[string][]string, error) {
	out := map[string][]string{}
	err := eachChunk(trackIDs, func(ids []string, ph string) error {
		rows, err := q.QueryContext(ctx,
			`SELECT track_id, tag_id FROM track_tags WHERE track_id IN (`+ph+`) ORDER BY track_id, tag_id`,
			anySlice(ids)...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id, tag string
			if err := rows.Scan(&id, &tag); err != nil {
				return err
			}
			out[id] = append(out[id], tag)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, fmt.Errorf("read tags: %w", err)
	}
	return out, nil
}

// ReferencesOf returns the references of each track in their stored order.
func ReferencesOf(ctx context.Context, q Querier, trackIDs []string) (map[string][]Reference, error) {
	out := map[string][]Reference{}
	err := eachChunk(trackIDs, func(ids []string, ph string) error {
		rows, err := q.QueryContext(ctx,
			`SELECT track_id, source_id, tokens FROM track_references
			 WHERE track_id IN (`+ph+`) ORDER BY track_id, ref_idx`,
			anySlice(ids)...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var (
				id string
				r  Reference
			)
			if err := rows.Scan(&id, &r.SourceID, &r.Tokens); err != nil {
				return err
			}
			out[id] = append(out[id], r)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, fmt.Errorf("read references: %w", err)
	}
	return out, nil
}

// TrackIDsCiting returns the tracks that cite a source, optionally at a
// position. A position matches itself and everything under it: "2" matches
// "2.13", "5.5" matches "5.5.3".
func TrackIDsCiting(ctx context.Context, q Querier, sourceID, tokens string) ([]string, error) {
	query := `SELECT DISTINCT track_id FROM track_references WHERE source_id = ?`
	args := []any{sourceID}
	if tokens != "" {
		query += ` AND (tokens = ? OR tokens LIKE ?)`
		args = append(args, tokens, tokens+".%")
	}
	ids, err := stringColumn(ctx, q, query+` ORDER BY track_id`, args...)
	if err != nil {
		return nil, fmt.Errorf("read tracks citing %s %s: %w", sourceID, tokens, err)
	}
	return ids, nil
}

// maxChunk keeps an IN list well under SQLite's bound-parameter limit.
const maxChunk = 500

// eachChunk calls fn with the ids in chunks, each with its "?,?,…" list.
func eachChunk(ids []string, fn func(ids []string, placeholders string) error) error {
	for len(ids) > 0 {
		n := min(len(ids), maxChunk)
		if err := fn(ids[:n], strings.TrimSuffix(strings.Repeat("?,", n), ",")); err != nil {
			return err
		}
		ids = ids[n:]
	}
	return nil
}

func anySlice(ss []string) []any {
	out := make([]any, len(ss))
	for i, s := range ss {
		out[i] = s
	}
	return out
}
