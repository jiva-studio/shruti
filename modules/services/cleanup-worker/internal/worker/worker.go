// Package worker drives the outbox consumer loop.
//
// Two paths feed events into the same dispatch:
//
//  1. LISTEN/NOTIFY (push). A dedicated *pgx.Conn parks on
//     conn.WaitForNotification; every NOTIFY 'outbox' wakes us, we read
//     unprocessed rows of that event_type, hand them to handlers, mark
//     processed.
//
//  2. Periodic sweep (durability). A time.Ticker on CLEANUP_SWEEP_INTERVAL
//     (default 5m) walks any unprocessed row older than 30s. Picks up
//     anything LISTEN missed during a connection drop, a restart, or a
//     producer that committed before NOTIFY fired.
//
// Both paths SELECT … FOR UPDATE SKIP LOCKED so multiple worker replicas
// (some day) can share the table without coordination.
package worker

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	cwdb "github.com/jiva-studio/lectorium/cleanup-worker/internal/db"
	"github.com/jiva-studio/lectorium/cleanup-worker/internal/handlers"
)

// Channel is the pg_notify channel name producers emit on. Matches the
// trigger in 0023_outbox.up.sql.
const Channel = "outbox"

// claimBatchSize caps how many rows a single Claim call returns. Picked
// from the spec: small enough that a stuck handler can't lock thousands
// of rows; large enough that a backlog drains in a single sweep.
const claimBatchSize = 100

// Worker bundles the long-lived state. Build once at boot.
type Worker struct {
	Pool          *pgxpool.Pool
	ListenConn    *pgx.Conn
	Registry      *handlers.Registry
	SweepInterval time.Duration
}

// Run blocks until ctx is cancelled or LISTEN dies unrecoverably.
//
// Startup contract: do one sweep first (catches whatever queued up while
// we were down), then start the listener. Both run concurrently after
// that — sweep on the ticker, listener on every NOTIFY.
func (w *Worker) Run(ctx context.Context) error {
	if err := w.sweep(ctx); err != nil && !errors.Is(err, context.Canceled) {
		slog.WarnContext(ctx, "initial_sweep_failed", slog.String("err", err.Error()))
		// Non-fatal: the periodic sweep will retry.
	}

	if _, err := w.ListenConn.Exec(ctx, "LISTEN "+Channel); err != nil {
		return fmt.Errorf("LISTEN %s: %w", Channel, err)
	}
	slog.InfoContext(ctx, "listening",
		slog.String("channel", Channel),
		slog.Duration("sweep_interval", w.SweepInterval),
	)

	errCh := make(chan error, 2)
	go func() { errCh <- w.runListener(ctx) }()
	go func() { errCh <- w.runSweeper(ctx) }()

	// First error from either goroutine cancels everything.
	err := <-errCh
	if errors.Is(err, context.Canceled) {
		return nil
	}
	return err
}

func (w *Worker) runListener(ctx context.Context) error {
	for {
		n, err := w.ListenConn.WaitForNotification(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return fmt.Errorf("wait notification: %w", err)
		}
		eventType := n.Payload
		if eventType == "" {
			// Defensive: a stray NOTIFY with no payload — fall through
			// to the sweep on the next tick.
			slog.WarnContext(ctx, "notify_empty_payload")
			continue
		}
		if err := w.processByType(ctx, eventType); err != nil && !errors.Is(err, context.Canceled) {
			slog.WarnContext(ctx, "process_by_type_failed",
				slog.String("event_type", eventType),
				slog.String("err", err.Error()),
			)
		}
	}
}

func (w *Worker) runSweeper(ctx context.Context) error {
	t := time.NewTicker(w.SweepInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			if err := w.sweep(ctx); err != nil && !errors.Is(err, context.Canceled) {
				slog.WarnContext(ctx, "sweep_failed", slog.String("err", err.Error()))
			}
		}
	}
}

// processByType handles the push path: drain every unprocessed row of
// this event_type. Looped because a burst of producer commits may
// outpace the NOTIFY signal.
func (w *Worker) processByType(ctx context.Context, eventType string) error {
	for {
		tx, events, err := cwdb.ClaimUnprocessedByType(ctx, w.Pool, eventType, claimBatchSize)
		if err != nil {
			return err
		}
		if len(events) == 0 {
			_ = tx.Rollback(ctx)
			return nil
		}
		stamped, err := w.dispatchAndCommit(ctx, tx, events)
		if err != nil {
			return err
		}
		// No forward progress on a non-empty batch means every row is a
		// poison row (handler error / unknown event_type) that the claim
		// query keeps re-selecting. Stop instead of spinning at 100% CPU;
		// the ticker-bounded sweep is where these stay loud-by-design.
		if stamped == 0 {
			return nil
		}
	}
}

// sweep handles the durability path: take whatever's been sitting for
// >30s regardless of event_type.
func (w *Worker) sweep(ctx context.Context) error {
	tx, events, err := cwdb.ClaimUnprocessedSweep(ctx, w.Pool, claimBatchSize)
	if err != nil {
		return err
	}
	if len(events) == 0 {
		_ = tx.Rollback(ctx)
		return nil
	}
	_, err = w.dispatchAndCommit(ctx, tx, events)
	return err
}

// dispatchAndCommit runs the handlers for each event in the claimed
// batch. Per row: every registered handler must return nil → UPDATE
// processed_at. Any handler error → log and skip the UPDATE for that
// row; next sweep retries it. Returns the number of rows actually
// stamped processed so the push-path drain can detect no forward
// progress and stop.
//
// Critically, we commit the tx at the end EVEN IF some rows weren't
// stamped — the UPDATEs for successful rows still need to land, and the
// rolled-back rows just stay unprocessed.
func (w *Worker) dispatchAndCommit(ctx context.Context, tx pgx.Tx, events []cwdb.Event) (int, error) {
	stamped := 0
	for _, evt := range events {
		hs := w.Registry.HandlersFor(evt.EventType)
		if len(hs) == 0 {
			// Don't stamp — keep for inspection. The row will reappear
			// every sweep, which is loud-by-design: an unknown event_type
			// is an operational bug, not a no-op.
			slog.WarnContext(ctx, "no_handler_for_event",
				slog.Int64("id", evt.ID),
				slog.String("event_type", evt.EventType),
				slog.String("aggregate_id", evt.AggregateID),
			)
			continue
		}
		ok := true
		for _, h := range hs {
			if err := h(ctx, evt); err != nil {
				slog.WarnContext(ctx, "handler_failed",
					slog.Int64("id", evt.ID),
					slog.String("event_type", evt.EventType),
					slog.String("aggregate_id", evt.AggregateID),
					slog.String("err", err.Error()),
				)
				ok = false
				break
			}
		}
		if !ok {
			continue
		}
		if err := cwdb.MarkProcessed(ctx, tx, evt.ID); err != nil {
			slog.WarnContext(ctx, "mark_processed_failed",
				slog.Int64("id", evt.ID),
				slog.String("err", err.Error()),
			)
			continue
		}
		stamped++
		slog.InfoContext(ctx, "event_processed",
			slog.Int64("id", evt.ID),
			slog.String("event_type", evt.EventType),
			slog.String("aggregate_id", evt.AggregateID),
		)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit: %w", err)
	}
	return stamped, nil
}
