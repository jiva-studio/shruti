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

	"github.com/jiva-studio/lectorium/ingest/internal/domain/ingest"
	"github.com/jiva-studio/lectorium/pipeline/transcript"
)

// Fetcher downloads a concrete source URL (via a configurable proxy) and
// returns the local path to the fetched audio plus its content hash (track_id).
// onProgress, when non-nil, is called with the download completion percent
// (0-100) as bytes arrive — best-effort and possibly never (a source/extractor
// that doesn't expose progress); the worker throttles and forwards it as a
// granular status heartbeat.
type Fetcher interface {
	Fetch(ctx context.Context, url string, onProgress func(percent int)) (localPath, contentHash string, err error)
}

// SourceInfo is best-effort metadata read off a source URL without downloading
// its media. Used to fill fields the title lacks: the uploader/channel as an
// author fallback, the publish date as a date fallback. Fields are empty when
// the source can't provide them.
type SourceInfo struct {
	Uploader   string // channel / uploader name
	UploadDate string // publish date as "YYYYMMDD" (yt-dlp), else ""
	Duration   int64  // source duration in seconds, 0 if unknown
}

// SourceProber reads a source URL's metadata without fetching its media.
type SourceProber interface {
	ProbeSource(ctx context.Context, url string) (SourceInfo, error)
}

// Transcriber turns a local audio file into a raw ASR transcript and reports
// the detected language. The worker windows the raw segments into the stored
// reviewed artifact via Reviewer.NormalizeTranscript.
type Transcriber interface {
	Transcribe(ctx context.Context, audioPath string) (raw transcript.Raw, lang string, err error)
}

// Reviewer resolves a raw TrackDraft's metadata (deterministic normalization
// today; LLM-assisted dictionary resolution is future work) and converts a raw
// ASR transcript into the reviewed artifact the corpus/app read
// (transcript.Reviewed — the same shape the MCP pipeline stores).
type Reviewer interface {
	Review(ctx context.Context, draft ingest.TrackDraft) (ingest.TrackDraft, error)
	NormalizeTranscript(raw transcript.Raw) transcript.Reviewed
}

// BlobStore writes artifacts to the content-addressed public path
// (public/tracks/<track_id>/…) and can HEAD-verify a key before it is announced.
type BlobStore interface {
	Put(ctx context.Context, key string, body []byte, contentType string) error
	Exists(ctx context.Context, key string) (bool, error)
}

// ResultPublisher emits an `ingest.result` message back to the orchestrator.
// The non-terminal heartbeat is best-effort, but the terminal result (ready |
// failed) is mandatory: the worker acks its `ingest.work` only after the
// terminal result is durably published, so a publish fault leaves the entry
// pending and redelivery re-runs the (content-addressed, idempotent) pipeline.
type ResultPublisher interface {
	Publish(ctx context.Context, r ingest.Result) error
}
