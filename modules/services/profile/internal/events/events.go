// Package events is the Personal Library ingest bridge: it consumes the
// Redis-Streams lifecycle events emitted by the orchestrator (ingest) and the
// publish-service (promotion) and projects them into a user's library_items row
// via the server-authored write path.
//
//   - `track.events`  (consumer group "profile"): the orchestrator's stream.
//     A `track.ready` event upserts the library_items projection; a
//     `track.removed` event deletes it. Other lifecycle types are ignored.
//   - `track.published` (consumer group "profile-published"): the
//     publish-service's stream. Each event flips the library item's
//     origin to 'published' for that track_id.
//
// Both transports share the Go redis-streams "payload" envelope convention (one
// JSON body in a single `payload` stream field), the same one the orchestrator
// and publish-service relays produce. Delivery is at-least-once; the write path
// is idempotent (a deterministic hlc keyed on the event id).
package events

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"github.com/jiva-studio/lectorium/profile/internal/wire"
)

// libraryItemsCollection is the single server-owned collection this bridge
// writes. Kept local so events has no dependency on store internals.
const libraryItemsCollection = "library_items"

// payloadField is the single stream field carrying the JSON body, matching the
// producers' redis-streams relay convention.
const payloadField = "payload"

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

// Applier is the subset of *service.Service the track.events consumer needs —
// the server-authored write path. An interface (not the concrete type) so events
// has no import cycle with service and is trivially faked in tests.
type Applier interface {
	ApplyServerChange(ctx context.Context, userID uuid.UUID, collection, docID, op, eventID string, data json.RawMessage) (wire.Change, error)
}

// PublishApplier is the subset of *service.Service the track.published consumer
// needs.
type PublishApplier interface {
	MarkPublished(ctx context.Context, userID uuid.UUID, trackID string) error
}

// TrackEvent is one decoded `track.events` message. `type` selects the op: a
// `track.ready` event upserts the projection; a `track.removed` event deletes
// it. Data is the server-owned library_items payload projected verbatim by
// ApplyServerChange.
//
// ID is the producer's deterministic idempotency key. It is passed to
// ApplyServerChange, which derives a DETERMINISTIC hlc from it, so a redelivered
// message writes exactly one change-log row instead of a duplicate.
type TrackEvent struct {
	ID     string          `json:"id"`
	Type   string          `json:"type"`
	UserID uuid.UUID       `json:"user_id"`
	DocID  string          `json:"doc_id"`
	Data   json.RawMessage `json:"data"`
}

// Consumer reads track.events and applies each as a server-authored change.
type Consumer struct {
	Applier Applier

	rdb      *redis.Client
	stream   string
	group    string
	consumer string
}

// NewConsumer wires the track.events consumer.
func NewConsumer(applier Applier, rdb *redis.Client, stream, group, consumer string) *Consumer {
	return &Consumer{Applier: applier, rdb: rdb, stream: stream, group: group, consumer: consumer}
}

// Run starts the XREADGROUP loop until the context is cancelled.
func (c *Consumer) Run(ctx context.Context) error {
	return runGroup(ctx, c.rdb, c.stream, c.group, c.consumer, c.process)
}

// process decodes one message and projects it. A malformed message is ACKed
// (returns nil) so it can't wedge the group; only a genuine write failure is
// returned (leaving the entry pending for redelivery).
func (c *Consumer) process(ctx context.Context, msgID string, payload []byte) error {
	var ev TrackEvent
	if err := json.Unmarshal(payload, &ev); err != nil {
		slog.WarnContext(ctx, "track_event_decode_failed", "msg_id", msgID, "err", err.Error())
		return nil
	}
	if ev.ID == "" {
		ev.ID = msgID // fall back to the stream id as the idempotency key
	}
	return c.handle(ctx, ev)
}

// handle projects a single decoded event through the server-authored write
// path. Exercised directly by the package tests.
func (c *Consumer) handle(ctx context.Context, ev TrackEvent) error {
	var op string
	switch ev.Type {
	case "track.ready":
		op = "upsert"
	case "track.removed":
		op = "delete"
	default:
		return nil // ignore queued/processing/failed
	}
	_, err := c.Applier.ApplyServerChange(ctx, ev.UserID, libraryItemsCollection, ev.DocID, op, ev.ID, ev.Data)
	return err
}

// PublishedEvent is one decoded `track.published` message: the publish-service
// announces that track_id (owned by owner_id) has been promoted into the
// published corpus.
type PublishedEvent struct {
	Type    string    `json:"type"`
	TrackID string    `json:"track_id"`
	OwnerID uuid.UUID `json:"owner_id"`
}

// PublishedConsumer reads track.published and flips the library item's origin.
type PublishedConsumer struct {
	Applier PublishApplier

	rdb      *redis.Client
	stream   string
	group    string
	consumer string
}

// NewPublishedConsumer wires the track.published consumer.
func NewPublishedConsumer(applier PublishApplier, rdb *redis.Client, stream, group, consumer string) *PublishedConsumer {
	return &PublishedConsumer{Applier: applier, rdb: rdb, stream: stream, group: group, consumer: consumer}
}

// Run starts the XREADGROUP loop until the context is cancelled.
func (c *PublishedConsumer) Run(ctx context.Context) error {
	return runGroup(ctx, c.rdb, c.stream, c.group, c.consumer, c.process)
}

func (c *PublishedConsumer) process(ctx context.Context, msgID string, payload []byte) error {
	var ev PublishedEvent
	if err := json.Unmarshal(payload, &ev); err != nil {
		slog.WarnContext(ctx, "published_event_decode_failed", "msg_id", msgID, "err", err.Error())
		return nil
	}
	return c.handle(ctx, ev)
}

func (c *PublishedConsumer) handle(ctx context.Context, ev PublishedEvent) error {
	if ev.TrackID == "" {
		return nil // unprocessable — ack to drop
	}
	return c.Applier.MarkPublished(ctx, ev.OwnerID, ev.TrackID)
}

// --- shared redis-streams transport ---

// processFn handles one consumed message; nil means the work committed and the
// entry is safe to XACK.
type processFn func(ctx context.Context, msgID string, payload []byte) error

const (
	readCount = 16
	readBlock = 5 * time.Second
	// reclaimMinIdle bounds how long a crashed consumer's in-flight entry waits
	// before another replica reclaims it.
	reclaimMinIdle = 15 * time.Minute
)

// runGroup creates the consumer group (idempotent, from the stream head so no
// pre-existing event is missed) and loops XAUTOCLAIM + XREADGROUP until ctx is
// cancelled, XACKing only after the handler succeeds (at-least-once).
func runGroup(ctx context.Context, rdb *redis.Client, stream, group, consumer string, fn processFn) error {
	if err := rdb.XGroupCreateMkStream(ctx, stream, group, "0").Err(); err != nil &&
		!strings.Contains(err.Error(), "BUSYGROUP") {
		return err
	}
	slog.InfoContext(ctx, "events_consumer_started", "stream", stream, "group", group)
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		reclaim(ctx, rdb, stream, group, consumer, fn)
		res, err := rdb.XReadGroup(ctx, &redis.XReadGroupArgs{
			Group:    group,
			Consumer: consumer,
			Streams:  []string{stream, ">"},
			Count:    readCount,
			Block:    readBlock,
		}).Result()
		if errors.Is(err, redis.Nil) || errors.Is(err, context.DeadlineExceeded) {
			continue
		}
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			slog.WarnContext(ctx, "xreadgroup_error", "stream", stream, "err", err.Error())
			time.Sleep(time.Second)
			continue
		}
		for _, st := range res {
			for _, m := range st.Messages {
				dispatch(ctx, rdb, stream, group, m, fn)
			}
		}
	}
}

func reclaim(ctx context.Context, rdb *redis.Client, stream, group, consumer string, fn processFn) {
	msgs, _, err := rdb.XAutoClaim(ctx, &redis.XAutoClaimArgs{
		Stream: stream, Group: group, Consumer: consumer,
		MinIdle: reclaimMinIdle, Start: "0-0", Count: readCount,
	}).Result()
	if err != nil {
		return
	}
	for _, m := range msgs {
		dispatch(ctx, rdb, stream, group, m, fn)
	}
}

func dispatch(ctx context.Context, rdb *redis.Client, stream, group string, m redis.XMessage, fn processFn) {
	payload := extractPayload(m.Values)
	if err := fn(ctx, m.ID, payload); err != nil {
		slog.WarnContext(ctx, "event_process_failed", "stream", stream, "msg_id", m.ID, "err", err.Error())
		return // leave pending → redelivered
	}
	if err := rdb.XAck(ctx, stream, group, m.ID).Err(); err != nil {
		slog.WarnContext(ctx, "xack_failed", "stream", stream, "msg_id", m.ID, "err", err.Error())
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
