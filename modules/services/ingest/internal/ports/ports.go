// Package ports declares the ingest worker's driven interfaces — the extension
// surface the runingest pipeline depends on. Adapters (yt-dlp fetcher, Deepgram
// transcriber, S3 blob store, the Redis result publisher) implement these, so
// the whole flow is exercised with fakes.
//
// The worker is STATELESS: there is no job repository, no transactional outbox,
// and no tier verifier here — those live in the orchestrator. The only outbound
// channel is ResultPublisher, which reports progress/terminal outcomes back on
// the `ingest.result` stream.
package ports

import (
	"context"

	"github.com/jiva-studio/shruti/ingest/internal/domain/ingest"
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

// Reviewer resolves a raw TrackDraft's metadata (deterministic normalization
// today; LLM-assisted dictionary resolution is future work).
type Reviewer interface {
	Review(ctx context.Context, draft ingest.TrackDraft) (ingest.TrackDraft, error)
}

// BlobStore writes artifacts to the content-addressed public path
// (public/tracks/<track_id>/…) and can HEAD-verify a key before it is announced.
type BlobStore interface {
	Put(ctx context.Context, key string, body []byte, contentType string) error
	Exists(ctx context.Context, key string) (bool, error)
}

// ResultPublisher emits an `ingest.result` message back to the orchestrator.
// Publishing is best-effort for the non-terminal heartbeat and mandatory for
// the terminal outcome, but the worker always acks after emitting exactly one
// terminal result regardless of publish latency (redelivery re-runs safely).
type ResultPublisher interface {
	Publish(ctx context.Context, r ingest.Result) error
}
