// Package ports declares what the promotion use case asks of the database
// when it needs more than one write to land together.
package ports

import (
	"context"

	"github.com/jiva-studio/shruti/publish/internal/domain"
)

// PromotionLedger opens a unit of work over the tracks ledger and its outbox.
//
// WithinTx runs fn in one transaction: it commits when fn returns nil and
// rolls back when fn returns an error, which it passes on.
type PromotionLedger interface {
	WithinTx(ctx context.Context, fn func(tx PromotionTx) error) error
}

// PromotionTx is what one unit of work may do. MarkPublished flips every
// still-unpublished track among the ids and returns them; Enqueue appends an
// announcement to the outbox.
type PromotionTx interface {
	MarkPublished(ctx context.Context, trackIDs []string) ([]domain.Promotion, error)
	Enqueue(ctx context.Context, topic string, payload []byte) error
}

// PendingExporter builds pending.db, the review file of the tracks not yet
// published, and says how many tracks it holds.
type PendingExporter interface {
	Export(ctx context.Context) (db []byte, tracks int, err error)
}
