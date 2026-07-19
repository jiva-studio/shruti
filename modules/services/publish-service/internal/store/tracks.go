package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Repo is the pgx-backed persistence for the promotion side: the `tracks`
// ledger (source of truth) plus the transactional outbox drained to the broker.
type Repo struct {
	pool *pgxpool.Pool
}

// New builds a Repo over an existing pool.
func New(pool *pgxpool.Pool) *Repo { return &Repo{pool: pool} }

// Track is one row learned from a `track.ready` event. Metadata is the raw event
// payload persisted verbatim so the pending.db review artifact can be rebuilt.
type Track struct {
	TrackID       string
	OwnerID       string
	Metadata      []byte // raw event Data JSON
	Lang          string
	AudioKey      string
	TranscriptKey string
}

// Upsert records (or refreshes) a track from a `track.ready` event. It never
// touches `published` — a redelivered ready event must not un-publish a track
// already promoted by the ticker.
func (r *Repo) Upsert(ctx context.Context, t Track) error {
	_, err := r.pool.Exec(ctx, `
		INSERT INTO publish.tracks (track_id, owner_id, metadata, lang, audio_key, transcript_key)
		VALUES ($1, $2, COALESCE($3::jsonb, '{}'::jsonb), $4, $5, $6)
		ON CONFLICT (track_id) DO UPDATE SET
			owner_id       = EXCLUDED.owner_id,
			metadata       = EXCLUDED.metadata,
			lang           = EXCLUDED.lang,
			audio_key      = EXCLUDED.audio_key,
			transcript_key = EXCLUDED.transcript_key,
			updated_at     = now()`,
		t.TrackID, nullStr(t.OwnerID), jsonbOrNil(t.Metadata),
		nullStr(t.Lang), nullStr(t.AudioKey), nullStr(t.TranscriptKey),
	)
	return err
}

// Promoted is one track flipped from unpublished → published by the ticker.
type Promoted struct {
	TrackID string
	OwnerID string
}

// PromoteMatching flips every still-unpublished track whose id is in catalogIDs
// to published and, in the SAME transaction, appends a `track.published` outbox
// row per promotion (payload built by mkPayload). Returns the promoted tracks.
//
// The whole reconciliation is one transaction so the published flip and its
// announcement commit atomically — the outbox invariant. Redelivery is absorbed
// downstream by the `track.published` consumers, which are idempotent.
func (r *Repo) PromoteMatching(
	ctx context.Context,
	catalogIDs []string,
	topic string,
	mkPayload func(p Promoted) ([]byte, error),
) ([]Promoted, error) {
	if len(catalogIDs) == 0 {
		return nil, nil
	}
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx, `
		UPDATE publish.tracks
		   SET published = true, published_at = now(), updated_at = now()
		 WHERE track_id = ANY($1) AND published = false
		RETURNING track_id, owner_id`, catalogIDs)
	if err != nil {
		return nil, fmt.Errorf("promote: %w", err)
	}
	var promoted []Promoted
	for rows.Next() {
		var (
			trackID string
			owner   *string
		)
		if err := rows.Scan(&trackID, &owner); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan promoted: %w", err)
		}
		promoted = append(promoted, Promoted{TrackID: trackID, OwnerID: deref(owner)})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate promoted: %w", err)
	}

	for _, p := range promoted {
		payload, err := mkPayload(p)
		if err != nil {
			return nil, fmt.Errorf("build payload %s: %w", p.TrackID, err)
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO publish.outbox (topic, payload) VALUES ($1, $2::jsonb)`,
			topic, string(payload)); err != nil {
			return nil, fmt.Errorf("outbox %s: %w", p.TrackID, err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}
	return promoted, nil
}

// --- Outbox drain (used by the redisstream relay) ---

// OutboxRow is one unpublished outbox entry.
type OutboxRow struct {
	Seq     int64
	Topic   string
	Payload []byte
}

// FetchUnpublished returns up to limit unpublished outbox rows in seq order.
func (r *Repo) FetchUnpublished(ctx context.Context, limit int) ([]OutboxRow, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT seq, topic, payload FROM publish.outbox
		  WHERE published_at IS NULL ORDER BY seq LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []OutboxRow
	for rows.Next() {
		var row OutboxRow
		if err := rows.Scan(&row.Seq, &row.Topic, &row.Payload); err != nil {
			return nil, err
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// MarkPublished stamps published_at on a drained outbox row.
func (r *Repo) MarkPublished(ctx context.Context, seq int64) error {
	_, err := r.pool.Exec(ctx,
		`UPDATE publish.outbox SET published_at = now() WHERE seq = $1`, seq)
	return err
}

// --- helpers ---

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func jsonbOrNil(b []byte) any {
	if len(b) == 0 {
		return nil
	}
	return string(b)
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
