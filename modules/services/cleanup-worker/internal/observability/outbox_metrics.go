// outbox_metrics exposes the `lectorium_outbox_pending_seconds` gauge —
// the max age of any unprocessed `app.outbox` row per event_type. The
// outbox_dead_letter Grafana rule fires off this gauge at >24h-stuck.
//
// The gauge is updated by a background poller that re-queries the outbox
// every PollerInterval. We scrape at ~15s in Prometheus; a slightly
// slower poll cadence is fine because the alert window (1h `for:`) is
// orders of magnitude larger than the poll lag.

package observability

import (
	"context"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
)

// OutboxPendingSeconds is the per-event_type gauge of "oldest unprocessed
// row's age in seconds". A per-event-type series lets the alert rule
// filter to specific event types if we ever want to (e.g. only page on
// subscription.broadcast since that's the cross-region delivery path).
var OutboxPendingSeconds = prometheus.NewGaugeVec(
	prometheus.GaugeOpts{
		Namespace: "lectorium",
		Subsystem: "outbox",
		Name:      "pending_seconds",
		Help: "Max age (now - occurred_at, seconds) of unprocessed app.outbox rows, per event_type. " +
			"Series absent when no pending row exists for that event_type.",
	},
	[]string{"event_type"},
)

func init() {
	prometheus.MustRegister(OutboxPendingSeconds)
}

// PollerInterval is how often the background goroutine re-queries the
// outbox to refresh the gauge. ~2x the Prometheus scrape interval (15s)
// keeps the gauge fresh between scrapes without hammering the DB —
// finer cadence buys nothing because the alert window is 1h.
const PollerInterval = 30 * time.Second

// StartOutboxPendingPoller spawns the background poller. Cancellation
// is via ctx; the goroutine returns silently when ctx is done. A poll
// failure is logged at WARN and the next tick retries — never fatal,
// the metric just goes stale (Prometheus' `up` covers that case at the
// scrape layer).
func StartOutboxPendingPoller(ctx context.Context, pool *pgxpool.Pool) {
	go func() {
		ticker := time.NewTicker(PollerInterval)
		defer ticker.Stop()
		// Run one refresh immediately so a freshly-booted worker doesn't
		// surface a stale-or-empty gauge for the first 30 seconds.
		if err := refreshGauge(ctx, pool); err != nil && ctx.Err() == nil {
			slog.WarnContext(ctx, "outbox_pending_poll_failed", "err", err.Error())
		}
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := refreshGauge(ctx, pool); err != nil && ctx.Err() == nil {
					slog.WarnContext(ctx, "outbox_pending_poll_failed", "err", err.Error())
				}
			}
		}
	}()
}

// refreshGauge re-queries app.outbox and re-publishes the gauge. We
// Reset() first so an event_type whose backlog has fully drained stops
// reporting (otherwise the last non-zero value would linger forever and
// the dead-letter alert would re-fire on a stale series).
func refreshGauge(ctx context.Context, pool *pgxpool.Pool) error {
	// Note: outbox column is `occurred_at`, not `created_at` (see
	// 0023_outbox.up.sql) — the producer stamps it at INSERT time, which
	// is what we want for "stuck since when".
	const q = `
		SELECT event_type,
		       EXTRACT(EPOCH FROM (now() - MIN(occurred_at)))::float8 AS oldest_age_seconds
		FROM app.outbox
		WHERE processed_at IS NULL
		GROUP BY event_type
	`
	rows, err := pool.Query(ctx, q)
	if err != nil {
		return err
	}
	defer rows.Close()

	OutboxPendingSeconds.Reset()
	for rows.Next() {
		var eventType string
		var ageSec float64
		if err := rows.Scan(&eventType, &ageSec); err != nil {
			return err
		}
		OutboxPendingSeconds.WithLabelValues(eventType).Set(ageSec)
	}
	return rows.Err()
}
