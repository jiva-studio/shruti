// Package redisstream is the broker transport: it consumes `ingest.request`
// with a consumer group and drains the transactional outbox to `track.events`.
// Both follow services/README-streams.md — at-least-once delivery, XACK only
// after the work commits, approximate MAXLEN trimming on every XADD, and
// XAUTOCLAIM to recover a crashed consumer's in-flight entries.
//
// Message convention: the JSON body travels in a single "payload" field, so a
// producer/consumer pair only needs to agree on that one key.
package redisstream

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// payloadField is the single stream field carrying the JSON body.
const payloadField = "payload"

// Handler processes one consumed message. Returning nil means the work
// committed and the entry is safe to XACK; a non-nil error leaves the entry
// pending for redelivery.
type Handler interface {
	Process(ctx context.Context, msgID string, payload []byte) error
}

// Connect opens a go-redis client from a redis:// URL and pings it.
func Connect(ctx context.Context, url string) (*redis.Client, error) {
	opt, err := redis.ParseURL(url)
	if err != nil {
		return nil, err
	}
	c := redis.NewClient(opt)
	pctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := c.Ping(pctx).Err(); err != nil {
		_ = c.Close()
		return nil, err
	}
	return c, nil
}

// Consumer reads `ingest.request` for one consumer group.
type Consumer struct {
	rdb      *redis.Client
	stream   string
	group    string
	consumer string
	handler  Handler
	block    time.Duration
	count    int64
	minIdle  time.Duration
}

// NewConsumer wires a consumer. group is the consuming service ("orchestrator");
// consumer is this container's id within the group.
func NewConsumer(rdb *redis.Client, stream, group, consumer string, h Handler) *Consumer {
	return &Consumer{
		rdb: rdb, stream: stream, group: group, consumer: consumer, handler: h,
		// minIdle must exceed the slowest in-flight stage (transcription can run
		// ~10 min) so a live-but-slow job isn't reclaimed by another replica and
		// processed twice. 15 min leaves headroom; a genuinely crashed consumer's
		// entries still get redelivered, just after this window.
		block: 5 * time.Second, count: 16, minIdle: 15 * time.Minute,
	}
}

// Run creates the group (idempotent) and loops until ctx is cancelled. Each
// iteration first reclaims stale pending entries (XAUTOCLAIM) then reads new
// ones (XREADGROUP >).
func (c *Consumer) Run(ctx context.Context) error {
	// Start at "0" (stream head), not "$": on a fresh deploy the orchestrator may
	// have emitted track.ready events before this group existed; "$" would skip
	// that backlog and those tracks would never be promoted. The consume handler
	// is idempotent, so replaying the (MAXLEN-bounded) head is safe. Mirrors the
	// profile consumer, which also creates its group at "0".
	if err := c.rdb.XGroupCreateMkStream(ctx, c.stream, c.group, "0").Err(); err != nil &&
		!strings.Contains(err.Error(), "BUSYGROUP") {
		return err
	}
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		c.reclaim(ctx)
		res, err := c.rdb.XReadGroup(ctx, &redis.XReadGroupArgs{
			Group:    c.group,
			Consumer: c.consumer,
			Streams:  []string{c.stream, ">"},
			Count:    c.count,
			Block:    c.block,
		}).Result()
		if errors.Is(err, redis.Nil) || errors.Is(err, context.DeadlineExceeded) {
			continue
		}
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			slog.WarnContext(ctx, "xreadgroup_error", "err", err.Error())
			time.Sleep(time.Second)
			continue
		}
		for _, st := range res {
			for _, m := range st.Messages {
				c.dispatch(ctx, m)
			}
		}
	}
}

// reclaim redelivers entries stuck in another (crashed) consumer's PEL.
func (c *Consumer) reclaim(ctx context.Context) {
	msgs, _, err := c.rdb.XAutoClaim(ctx, &redis.XAutoClaimArgs{
		Stream: c.stream, Group: c.group, Consumer: c.consumer,
		MinIdle: c.minIdle, Start: "0-0", Count: c.count,
	}).Result()
	if err != nil {
		return
	}
	for _, m := range msgs {
		c.dispatch(ctx, m)
	}
}

// dispatch runs the handler and XACKs only on success (at-least-once).
func (c *Consumer) dispatch(ctx context.Context, m redis.XMessage) {
	payload := extractPayload(m.Values)
	if err := c.handler.Process(ctx, m.ID, payload); err != nil {
		slog.WarnContext(ctx, "ingest_process_failed", "msg_id", m.ID, "err", err.Error())
		return // leave pending → redelivered
	}
	if err := c.rdb.XAck(ctx, c.stream, c.group, m.ID).Err(); err != nil {
		slog.WarnContext(ctx, "xack_failed", "msg_id", m.ID, "err", err.Error())
	}
}

func extractPayload(values map[string]any) []byte {
	if v, ok := values[payloadField]; ok {
		if s, ok := v.(string); ok {
			return []byte(s)
		}
	}
	return nil
}

// --- outbox relay ---

// OutboxSource is the subset of the postgres repo the relay drains. The single
// method claims a batch FOR UPDATE SKIP LOCKED and, in one tx, calls publish for
// each row and marks it published — so racing relay replicas never double-XADD.
type OutboxSource interface {
	DrainUnpublished(ctx context.Context, limit int, publish func(topic string, payload []byte) error) (int, error)
}

// Relay drains unpublished outbox rows to the broker, XADDing each with an
// approximate MAXLEN cap and stamping it published. At-least-once: a crash
// between XADD and the published stamp redelivers, absorbed by idempotent
// consumers.
type Relay struct {
	rdb    *redis.Client
	src    OutboxSource
	maxLen int64
	batch  int
	tick   time.Duration
}

// NewRelay wires the relay.
func NewRelay(rdb *redis.Client, src OutboxSource, maxLen int64) *Relay {
	return &Relay{rdb: rdb, src: src, maxLen: maxLen, batch: 100, tick: time.Second}
}

// Run polls the outbox until ctx is cancelled.
func (r *Relay) Run(ctx context.Context) error {
	t := time.NewTicker(r.tick)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			r.drain(ctx)
		}
	}
}

func (r *Relay) drain(ctx context.Context) {
	// The claim + XADD + mark happen inside one DB tx (FOR UPDATE SKIP LOCKED) so
	// concurrent relay replicas can't drain the same row twice. A failing XADD
	// aborts the tx, so the whole batch stays unpublished and retries next tick
	// (order preserved; at-least-once absorbed by idempotent consumers).
	if _, err := r.src.DrainUnpublished(ctx, r.batch, func(topic string, payload []byte) error {
		return r.rdb.XAdd(ctx, &redis.XAddArgs{
			Stream: topic,
			MaxLen: r.maxLen,
			Approx: true,
			Values: map[string]any{payloadField: string(payload)},
		}).Err()
	}); err != nil {
		slog.WarnContext(ctx, "outbox_drain_failed", "err", err.Error())
	}
}
