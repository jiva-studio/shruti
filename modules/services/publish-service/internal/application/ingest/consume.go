// Package ingest holds the `track.ready` consumer handler: it decodes the
// orchestrator's lifecycle event and upserts the track into the
// publish-service's own `tracks` ledger. It is the read side of the promotion
// pipeline — the ticker (package promote) is the write/announce side.
package ingest

import (
	"context"
	"encoding/json"
	"log/slog"

	"github.com/jiva-studio/lectorium/publish/internal/store"
)

// eventTypeReady is the only lifecycle type this service acts on. The rest of
// the `track.events` stream (queued/processing/failed) is ACKed and ignored.
const eventTypeReady = "track.ready"

// Upserter is the subset of store.Repo the handler needs — an interface so the
// handler is faked in tests without Postgres.
type Upserter interface {
	Upsert(ctx context.Context, t store.Track) error
}

// trackEvent mirrors the orchestrator's ingest.TrackEvent wire shape (the
// `track.events` contract). Data is the server-owned projection the orchestrator
// ships; for track.ready it carries {lang, audio_key, transcript_key, title, …}.
type trackEvent struct {
	ID      string          `json:"id"`
	Type    string          `json:"type"`
	UserID  string          `json:"user_id"`
	DocID   string          `json:"doc_id"`
	TrackID string          `json:"track_id,omitempty"`
	Data    json.RawMessage `json:"data,omitempty"`
}

// readyData is the subset of the track.ready payload promoted into typed columns.
type readyData struct {
	Lang          string `json:"lang"`
	AudioKey      string `json:"audio_key"`
	TranscriptKey string `json:"transcript_key"`
}

// Handler implements redisstream.Handler: it processes one `track.events`
// message. Non-ready types and malformed payloads are ACKed (returned nil) so a
// poison message never wedges the consumer group; only a genuine DB failure is
// returned (leaving the entry pending for redelivery).
type Handler struct {
	Repo Upserter
}

// New wires the handler.
func New(repo Upserter) *Handler { return &Handler{Repo: repo} }

// Process decodes one message and upserts a ready track.
func (h *Handler) Process(ctx context.Context, msgID string, payload []byte) error {
	var ev trackEvent
	if err := json.Unmarshal(payload, &ev); err != nil {
		slog.WarnContext(ctx, "track_event_decode_failed", "msg_id", msgID, "err", err.Error())
		return nil // unprocessable — ack to drop
	}
	if ev.Type != eventTypeReady {
		return nil // ignore queued/processing/failed
	}

	trackID := ev.TrackID
	if trackID == "" {
		trackID = ev.DocID
	}
	if trackID == "" {
		slog.WarnContext(ctx, "track_ready_missing_track_id", "msg_id", msgID)
		return nil
	}

	var d readyData
	if len(ev.Data) > 0 {
		_ = json.Unmarshal(ev.Data, &d) // best-effort; metadata is stored verbatim regardless
	}

	if err := h.Repo.Upsert(ctx, store.Track{
		TrackID:       trackID,
		OwnerID:       ev.UserID,
		Metadata:      ev.Data,
		Lang:          d.Lang,
		AudioKey:      d.AudioKey,
		TranscriptKey: d.TranscriptKey,
	}); err != nil {
		slog.WarnContext(ctx, "track_upsert_failed", "msg_id", msgID, "track_id", trackID, "err", err.Error())
		return err // leave pending → redelivered
	}
	slog.InfoContext(ctx, "track_ingested", "track_id", trackID, "owner_id", ev.UserID)
	return nil
}
