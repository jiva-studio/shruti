// Package redisstream is storage-sync's broker transport: it consumes
// `track.events` and mirrors a freshly published track's blobs immediately.
//
// It follows the same contract as every other Go consumer in the fleet
// (services/README-streams.md): the JSON body travels in a single `payload`
// stream field, delivery is at-least-once, XACK happens only after the work
// commits, and a stale pending entry is recovered with XAUTOCLAIM — Redis
// Streams does NOT redeliver on its own, since the read loop only asks for new
// (">") entries.
package redisstream

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/jiva-studio/shruti-storage-sync/internal/domain/mirror"
)

// payloadField is the single stream field carrying the JSON body.
const payloadField = "payload"

// TrackSyncer is the application core seen from the transport — mirroring the
// blobs one `track.ready` announced.
type TrackSyncer interface {
	SyncTrack(ctx context.Context, t mirror.TrackReady) (int, error)
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

// Consumer reads `track.events` for one consumer group.
type Consumer struct {
	rdb      *redis.Client
	stream   string
	group    string
	consumer string
	syncer   TrackSyncer
	block    time.Duration
	count    int64
	minIdle  time.Duration
}

// NewConsumer wires the consumer. group is this service ("storage-sync");
// consumer is this container's id within the group.
func NewConsumer(rdb *redis.Client, stream, group, consumer string, s TrackSyncer) *Consumer {
	return &Consumer{
		rdb: rdb, stream: stream, group: group, consumer: consumer, syncer: s,
		// minIdle must exceed the slowest in-flight handle — mirroring a large
		// audio blob can take minutes — so a live-but-slow transfer on one
		// replica is not reclaimed and re-run by another. 15 min matches the
		// ingest/orchestrator/profile consumers.
		block: 5 * time.Second, count: 16, minIdle: 15 * time.Minute,
	}
}

// Run creates the group (idempotent) and loops until ctx is cancelled. Each
// iteration first reclaims stale pending entries, then reads new ones.
func (c *Consumer) Run(ctx context.Context) error {
	// Start at "0", not "$": on a fresh deploy the orchestrator may have emitted
	// track.ready before this group existed, and "$" would skip that backlog
	// permanently. Mirroring is idempotent, so replaying the (MAXLEN-bounded)
	// head is safe. Matches publish/profile/chat.
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

// reclaim redelivers entries stuck in a crashed consumer's PEL.
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
	if err := c.Handle(ctx, extractPayload(m.Values)); err != nil {
		slog.WarnContext(ctx, "track_event_sync_failed", "msg_id", m.ID, "err", err.Error())
		return // leave pending → reclaimed and retried
	}
	if err := c.rdb.XAck(ctx, c.stream, c.group, m.ID).Err(); err != nil {
		slog.WarnContext(ctx, "xack_failed", "msg_id", m.ID, "err", err.Error())
	}
}

// Handle mirrors one event. It returns nil (safe to ack) for anything this
// service has no work for — a different lifecycle type, an event with no blob
// keys, or an unparseable payload (a poison pill must not wedge the group) —
// and a non-nil error only when the mirroring itself failed and should retry.
//
// Exported so tests drive it with a raw payload, no broker required.
func (c *Consumer) Handle(ctx context.Context, payload []byte) error {
	t, ok, err := mirror.DecodeTrackReady(payload)
	if err != nil {
		slog.WarnContext(ctx, "track_event_decode_failed", "err", err.Error())
		return nil // poison pill — ack to drop
	}
	if !ok {
		return nil // not a track.ready, or nothing to mirror
	}
	copied, err := c.syncer.SyncTrack(ctx, t)
	if err != nil {
		return err
	}
	slog.InfoContext(ctx, "track_mirrored", "track_id", t.TrackID, "copied", copied)
	return nil
}

func extractPayload(values map[string]any) []byte {
	if v, ok := values[payloadField]; ok {
		if s, ok := v.(string); ok {
			return []byte(s)
		}
	}
	return nil
}
