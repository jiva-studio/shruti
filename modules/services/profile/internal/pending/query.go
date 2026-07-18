package pending

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// QueryRows reads every user-generated track eligible for corpus review: the
// server-owned library_items that are fully fetched + normalized (status
// 'ready') and already carry a track_id. Items still fetching (track_id NULL)
// or in any non-ready state are excluded.
//
// Follow-up (see PR / #1236): tracks already promoted into the published corpus
// catalog are NOT excluded here — re-listing an approved track is harmless
// because library.approve / track.commit is idempotent on track_id.
func QueryRows(ctx context.Context, pool *pgxpool.Pool) ([]Row, error) {
	const q = `
		SELECT user_id, track_id,
		       title_raw, author_raw, location_raw, date_raw,
		       lang, lang_hint,
		       transcript_key, audio_key,
		       duration, added_at
		  FROM profile.library_items
		 WHERE status = 'ready' AND track_id IS NOT NULL
		 ORDER BY added_at`
	rows, err := pool.Query(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("query library_items: %w", err)
	}
	defer rows.Close()

	var out []Row
	for rows.Next() {
		var (
			userID  uuid.UUID
			trackID string
			r       Row
		)
		if err := rows.Scan(
			&userID, &trackID,
			&r.TitleRaw, &r.AuthorRaw, &r.LocationRaw, &r.DateRaw,
			&r.Lang, &r.LangHint,
			&r.TranscriptKey, &r.AudioKey,
			&r.DurationSec, &r.AddedAt,
		); err != nil {
			return nil, fmt.Errorf("scan library_items: %w", err)
		}
		r.OwnerID = userID.String()
		r.TrackID = trackID
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate library_items: %w", err)
	}
	return out, nil
}
