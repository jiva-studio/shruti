package pending

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// QueryRows reads every not-yet-published track — the publish-service's own
// `tracks` rows with published = false — for export into the review artifact.
// Once a track is promoted (published = true) it drops out of pending.db,
// which is how the offline admin MCP sees a shrinking review queue.
//
// Raw metadata columns (title/author/location/date/lang_hint) are read out of
// the `metadata` jsonb the track.ready event shipped; lang / audio_key /
// transcript_key come from their own columns.
func QueryRows(ctx context.Context, pool *pgxpool.Pool) ([]Row, error) {
	const q = `
		SELECT owner_id, track_id,
		       metadata->>'title'     AS title_raw,
		       metadata->>'author'    AS author_raw,
		       metadata->>'location'  AS location_raw,
		       metadata->>'date'      AS date_raw,
		       lang,
		       metadata->>'lang_hint' AS lang_hint,
		       transcript_key, audio_key,
		       created_at
		  FROM publish.tracks
		 WHERE published = false
		 ORDER BY created_at`
	rows, err := pool.Query(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("query tracks: %w", err)
	}
	defer rows.Close()

	var out []Row
	for rows.Next() {
		var (
			ownerID *string
			trackID string
			r       Row
		)
		if err := rows.Scan(
			&ownerID, &trackID,
			&r.TitleRaw, &r.AuthorRaw, &r.LocationRaw, &r.DateRaw,
			&r.Lang, &r.LangHint,
			&r.TranscriptKey, &r.AudioKey,
			&r.AddedAt,
		); err != nil {
			return nil, fmt.Errorf("scan tracks: %w", err)
		}
		if ownerID != nil {
			r.OwnerID = *ownerID
		}
		r.TrackID = trackID
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate tracks: %w", err)
	}
	return out, nil
}
