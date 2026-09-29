package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti/publish/internal/domain"
	"github.com/jiva-studio/shruti/publish/internal/ports"
)

// Repo is the pgx-backed persistence for the promotion side: the `tracks`
// ledger (source of truth) plus the transactional outbox drained to the broker.
type Repo struct {
	pool *pgxpool.Pool
}

// New builds a Repo over an existing pool.
func New(pool *pgxpool.Pool) *Repo { return &Repo{pool: pool} }

// Upsert records (or refreshes) a track from a `track.ready` event. It never
// touches `published` — a redelivered ready event must not un-publish a track
// already promoted by the ticker.
func (r *Repo) Upsert(ctx context.Context, t domain.Track) error {
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

// WithinTx runs fn in one transaction over the ledger and the outbox, so a
// published flip and its announcement commit together or not at all.
func (r *Repo) WithinTx(ctx context.Context, fn func(tx ports.PromotionTx) error) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := fn(promotionTx{tx: tx}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

// promotionTx is one unit of work opened by WithinTx.
type promotionTx struct {
	tx pgx.Tx
}

// MarkPublished flips every still-unpublished track whose id is in trackIDs.
func (p promotionTx) MarkPublished(ctx context.Context, trackIDs []string) ([]domain.Promotion, error) {
	rows, err := p.tx.Query(ctx, `
		UPDATE publish.tracks
		   SET published = true, published_at = now(), updated_at = now()
		 WHERE track_id = ANY($1) AND published = false
		RETURNING track_id, owner_id`, trackIDs)
	if err != nil {
		return nil, fmt.Errorf("promote: %w", err)
	}
	var promoted []domain.Promotion
	for rows.Next() {
		var (
			trackID string
			owner   *string
		)
		if err := rows.Scan(&trackID, &owner); err != nil {
			rows.Close()
			return nil, fmt.Errorf("scan promoted: %w", err)
		}
		promoted = append(promoted, domain.Promotion{TrackID: trackID, OwnerID: deref(owner)})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate promoted: %w", err)
	}
	return promoted, nil
}

// Enqueue appends one announcement to the outbox.
func (p promotionTx) Enqueue(ctx context.Context, topic string, payload []byte) error {
	_, err := p.tx.Exec(ctx,
		`INSERT INTO publish.outbox (topic, payload) VALUES ($1, $2::jsonb)`,
		topic, string(payload))
	return err
}

// --- Outbox drain (used by the redisstream relay) ---

// DrainUnpublished claims up to limit unpublished outbox rows with
// `FOR UPDATE SKIP LOCKED` and — in ONE transaction — publishes each via
// publish() and stamps it published. The row lock keeps the relay safe on
// MULTIPLE publish-service replicas: a second replica's SELECT skips the rows
// the first claimed, so track.published is never XADDed twice by racing relays.
// Ordering (ORDER BY seq) is preserved and delivery stays at-least-once: a
// publish error rolls the batch back, leaving those rows for the next tick.
func (r *Repo) DrainUnpublished(ctx context.Context, limit int, publish func(topic string, payload []byte) error) (int, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx,
		`SELECT seq, topic, payload FROM publish.outbox
		  WHERE published_at IS NULL ORDER BY seq LIMIT $1 FOR UPDATE SKIP LOCKED`, limit)
	if err != nil {
		return 0, err
	}
	// Buffer the batch before publishing: pgx forbids issuing the per-row UPDATE
	// while the SELECT cursor is still open on the same tx.
	type outboxRow struct {
		seq     int64
		topic   string
		payload []byte
	}
	var batch []outboxRow
	for rows.Next() {
		var row outboxRow
		if err := rows.Scan(&row.seq, &row.topic, &row.payload); err != nil {
			rows.Close()
			return 0, err
		}
		batch = append(batch, row)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}

	n := 0
	for _, row := range batch {
		if err := publish(row.topic, row.payload); err != nil {
			return n, err // rollback: this batch stays unpublished, redelivered next tick
		}
		if _, err := tx.Exec(ctx,
			`UPDATE publish.outbox SET published_at = now() WHERE seq = $1`, row.seq); err != nil {
			return n, err
		}
		n++
	}
	if err := tx.Commit(ctx); err != nil {
		return n, err
	}
	return n, nil
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
