// Package promote is the promotion side of the publish-service: a periodic
// ticker that reconciles the local `tracks` ledger against the published corpus
// catalog. For every catalog track this service still holds as unpublished it
// flips `published`, emits `track.published` (via the transactional outbox), and
// then rebuilds the `pending.db` review artifact from the remaining unpublished
// rows and uploads it to S3.
package promote

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/jiva-studio/lectorium/publish/internal/pending"
	"github.com/jiva-studio/lectorium/publish/internal/store"
)

// PublishedEvent is the `track.published` payload emitted per promotion. Both
// consumers (profile → origin='published'; chat → graft user_track→corpus) read
// it: profile keys on owner_id, chat on user_id — the same value is sent under
// both keys so neither consumer needs to know the other's convention.
type PublishedEvent struct {
	Type    string `json:"type"`
	TrackID string `json:"track_id"`
	OwnerID string `json:"owner_id"`
	UserID  string `json:"user_id"`
}

// Reconciler is the subset of store.Repo the promoter needs.
type Reconciler interface {
	PromoteMatching(ctx context.Context, catalogIDs []string, topic string, mkPayload func(store.Promoted) ([]byte, error)) ([]store.Promoted, error)
}

// CatalogReader yields the track ids currently live in the published corpus.
type CatalogReader interface {
	PublishedTrackIDs(ctx context.Context) ([]string, error)
}

// Uploader writes the rebuilt pending.db to blob storage.
type Uploader interface {
	Put(ctx context.Context, key string, body []byte, contentType string) error
}

// RowsFn returns the current not-yet-published rows for the pending.db build.
type RowsFn func(ctx context.Context) ([]pending.Row, error)

// Promoter runs the reconciliation cycle.
type Promoter struct {
	repo            Reconciler
	catalog         CatalogReader
	blob            Uploader
	rows            RowsFn
	publishedStream string
	pendingKey      string
	interval        time.Duration
}

// Deps bundles the promoter's dependencies.
type Deps struct {
	Repo            Reconciler
	Catalog         CatalogReader
	Blob            Uploader
	Rows            RowsFn
	PublishedStream string
	PendingKey      string
	Interval        time.Duration
}

// New wires a Promoter.
func New(d Deps) *Promoter {
	interval := d.Interval
	if interval <= 0 {
		interval = 5 * time.Minute
	}
	return &Promoter{
		repo:            d.Repo,
		catalog:         d.Catalog,
		blob:            d.Blob,
		rows:            d.Rows,
		publishedStream: d.PublishedStream,
		pendingKey:      d.PendingKey,
		interval:        interval,
	}
}

// mkPayload builds the track.published envelope for one promotion.
func (p *Promoter) mkPayload(pr store.Promoted) ([]byte, error) {
	return json.Marshal(PublishedEvent{
		Type:    "track.published",
		TrackID: pr.TrackID,
		OwnerID: pr.OwnerID,
		UserID:  pr.OwnerID,
	})
}

// RunOnce performs a single reconciliation cycle: promote matched tracks, then
// rebuild + upload pending.db.
func (p *Promoter) RunOnce(ctx context.Context) error {
	ids, err := p.catalog.PublishedTrackIDs(ctx)
	if err != nil {
		return fmt.Errorf("read catalog: %w", err)
	}
	promoted, err := p.repo.PromoteMatching(ctx, ids, p.publishedStream, p.mkPayload)
	if err != nil {
		return fmt.Errorf("promote: %w", err)
	}
	if len(promoted) > 0 {
		slog.InfoContext(ctx, "tracks_promoted", "count", len(promoted))
	}
	if err := p.rebuildPending(ctx); err != nil {
		return fmt.Errorf("rebuild pending.db: %w", err)
	}
	return nil
}

// rebuildPending exports the remaining unpublished rows into a fresh pending.db
// and uploads it.
func (p *Promoter) rebuildPending(ctx context.Context) error {
	rows, err := p.rows(ctx)
	if err != nil {
		return err
	}
	dir, err := os.MkdirTemp("", "pending-db-")
	if err != nil {
		return fmt.Errorf("tempdir: %w", err)
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "pending.db")
	if err := pending.WriteDB(ctx, path, rows); err != nil {
		return err
	}
	blob, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read built db: %w", err)
	}
	if err := p.blob.Put(ctx, p.pendingKey, blob, "application/x-sqlite3"); err != nil {
		return fmt.Errorf("upload %s: %w", p.pendingKey, err)
	}
	slog.InfoContext(ctx, "pending_db_published", "key", p.pendingKey, "rows", len(rows), "bytes", len(blob))
	return nil
}

// Start runs RunOnce immediately, then on every tick until ctx is cancelled. A
// cycle failure is logged and the loop continues (a transient catalog/S3/DB blip
// must not kill the promoter).
func (p *Promoter) Start(ctx context.Context) {
	if err := p.RunOnce(ctx); err != nil && ctx.Err() == nil {
		slog.ErrorContext(ctx, "promote_cycle_failed", "err", err.Error())
	}
	ticker := time.NewTicker(p.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			slog.Info("promoter_stopped")
			return
		case <-ticker.C:
			if err := p.RunOnce(ctx); err != nil && ctx.Err() == nil {
				slog.ErrorContext(ctx, "promote_cycle_failed", "err", err.Error())
			}
		}
	}
}
