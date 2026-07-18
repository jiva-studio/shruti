// Package ports declares the orchestrator's driven interfaces — the extension
// surface. Adapters (yt-dlp fetcher, Deepgram transcriber, S3 blob store, Redis
// event bus, Postgres job repo) implement these behind the pipeline use case.
//
// Signatures here are intentionally minimal for the scaffold; the ingest
// pipeline issues (#1221–#1223) flesh them out (e.g. richer transcript types
// come from the shared pipeline module).
package ports

import (
	"context"
	"time"

	"github.com/jiva-studio/shruti/orchestrator/internal/domain/ingest"
	"github.com/jiva-studio/shruti/orchestrator/internal/domain/job"
)

// Fetcher downloads a concrete source URL (via a configurable proxy) and
// returns the local path to the fetched audio plus its content hash (track_id).
type Fetcher interface {
	Fetch(ctx context.Context, url string) (localPath, contentHash string, err error)
}

// Transcriber turns a local audio file into a transcript artifact and reports
// the ASR-detected language.
type Transcriber interface {
	Transcribe(ctx context.Context, audioPath string) (transcript []byte, lang string, err error)
}

// Reviewer resolves a raw TrackDraft's metadata against the corpus
// dictionaries (author/location/date/lang), returning the enriched draft. It is
// the (LLM-assisted) review stage between transcription and store.
type Reviewer interface {
	Review(ctx context.Context, draft ingest.TrackDraft) (ingest.TrackDraft, error)
}

// BlobStore writes artifacts to the content-addressed public path
// (public/tracks/<track_id>/…) and can HEAD-verify a key before it is announced.
type BlobStore interface {
	Put(ctx context.Context, key string, body []byte, contentType string) error
	Exists(ctx context.Context, key string) (bool, error)
}

// EventBus publishes lifecycle events to the broker via the transactional
// outbox (the payload is enqueued in the same tx as the job write).
type EventBus interface {
	Publish(ctx context.Context, q Tx, topic string, payload []byte) error
}

// JobRepository persists the Job aggregate — the source of truth.
type JobRepository interface {
	Create(ctx context.Context, j *job.Job) error
	Get(ctx context.Context, id string) (*job.Job, error)
	Save(ctx context.Context, j *job.Job) error
	// WithTx runs fn inside a transaction so a job write and its outbox event
	// commit atomically.
	WithTx(ctx context.Context, fn func(Tx) error) error
}

// Tx is an opaque transaction handle threaded through repository + event bus so
// the outbox write shares the job write's transaction.
type Tx interface{}

// Clock supplies the current time. Injected so job timestamps and pipeline
// timeouts are deterministic under test (production uses a wall-clock impl).
type Clock interface {
	Now() time.Time
}

// IDGen mints unique job ids (opaque to the domain; UUIDv4 in production).
type IDGen interface {
	NewID() string
}
