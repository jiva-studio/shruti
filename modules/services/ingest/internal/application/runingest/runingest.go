// Package runingest is the ingest worker's pipeline use case: it consumes one
// `ingest.work` command, drives it through fetch → content-hash → transcribe →
// review → store, and reports progress and the terminal outcome on the
// `ingest.result` stream. It depends ONLY on ports, so the whole flow is
// exercised with fakes.
//
// The worker is STATELESS — no Postgres, no job store, no retry accounting:
//
//   - Idempotency comes from content-addressing: Fetch is pure and Put writes
//     to `public/tracks/<hash>/…`, so a redelivered `ingest.work` (e.g. after a
//     crash or a lost result before XACK) re-runs safely and converges on the
//     same keys — a duplicate re-transcribe simply overwrites identical bytes.
//   - Stored artifacts match the MCP pipeline exactly: audio at
//     `public/tracks/<hash>/audio/original.mp3` and the reviewed transcript at
//     `public/tracks/<hash>/transcripts/<lang>.json`.
//   - The worker emits ONE terminal result (ready | failed) and acks only once
//     it is durably published. It never retries the pipeline for a business
//     failure and never tracks attempts — the retry policy (and the attempt
//     cap) lives entirely in the orchestrator.
package runingest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/jiva-studio/shruti/ingest/internal/domain/ingest"
	"github.com/jiva-studio/shruti/ingest/internal/ports"
)

// Deps bundles the ports the pipeline needs.
type Deps struct {
	Fetcher     ports.Fetcher
	Transcriber ports.Transcriber
	Reviewer    ports.Reviewer
	Blob        ports.BlobStore
	Results     ports.ResultPublisher
}

// Service runs the pipeline.
type Service struct {
	d Deps
}

// New builds a Service.
func New(d Deps) *Service { return &Service{d: d} }

// Process handles one `ingest.work` message. It returns nil (safe to XACK) only
// after the TERMINAL result (ready | failed) is durably published; a publish
// fault on the terminal result returns an error so the entry stays pending and
// redelivery re-runs the (content-addressed, idempotent) pipeline. The worker
// never retries the pipeline for a business failure — the orchestrator owns that
// from the Retriable flag. A non-decodable payload is a poison pill (nil, drop).
func (s *Service) Process(ctx context.Context, _ string, payload []byte) error {
	cmd, err := ingest.DecodeWork(payload)
	if err != nil {
		// Poison pill. This is the ONE path with no job_id to correlate on, so
		// log it — otherwise a malformed producer drops messages invisibly.
		slog.WarnContext(ctx, "ingest_poison_pill", "error", err.Error(), "bytes", len(payload))
		return nil // unparseable; ack to drop it
	}

	// Every line for this message carries job_id + attempt, so one ingest is a
	// single LogQL filter across the whole pipeline.
	lg := slog.With("job_id", cmd.JobID, "request_id", cmd.RequestID, "attempt", cmd.Attempt)
	started := time.Now()
	lg.InfoContext(ctx, "ingest_started", "url", cmd.URL)

	// Best-effort heartbeat: moves the orchestrator's job queued → running.
	s.emit(ctx, ingest.Result{JobID: cmd.JobID, RequestID: cmd.RequestID, Attempt: cmd.Attempt, Phase: ingest.PhaseProcessing})

	stage := time.Now()
	localPath, hash, err := s.d.Fetcher.Fetch(ctx, cmd.URL)
	if err != nil {
		return s.fail(ctx, lg, cmd, fmt.Errorf("fetch: %w", err))
	}
	defer os.RemoveAll(filepath.Dir(localPath))
	lg = lg.With("track_id", hash) // known from here on — carry it forward
	lg.InfoContext(ctx, "ingest_fetched", "duration_ms", ms(stage))

	audio, err := os.ReadFile(localPath)
	if err != nil {
		return s.fail(ctx, lg, cmd, fmt.Errorf("read audio: %w", err))
	}

	stage = time.Now()
	raw, _, err := s.d.Transcriber.Transcribe(ctx, localPath)
	if err != nil {
		return s.fail(ctx, lg, cmd, fmt.Errorf("transcribe: %w", err))
	}
	lg.InfoContext(ctx, "ingest_transcribed",
		"duration_ms", ms(stage), "lang", raw.Language, "audio_bytes", len(audio))
	raw.TrackId = hash
	if raw.Language == "" {
		raw.Language = "und" // keep the transcripts/<lang>.json key well-formed
	}

	// Window the raw ASR segments into the reviewed artifact the corpus/app read
	// (transcript.Reviewed — the exact shape + key the MCP pipeline stores).
	reviewed := s.d.Reviewer.NormalizeTranscript(raw)
	if len(reviewed.Blocks) == 0 {
		// Deepgram returned 200 but no usable speech. Announcing this as ready
		// would store an empty transcript the app/corpus can't use, with no
		// recovery. Fail RETRIABLY (not ErrPermanent): a transient ASR hiccup
		// clears on retry, and a genuinely silent source dead-letters as failed
		// after the attempt cap rather than masquerading as a ready track.
		return s.fail(ctx, lg, cmd, fmt.Errorf("transcription produced no blocks"))
	}
	transcriptBody, err := json.Marshal(reviewed)
	if err != nil {
		return s.fail(ctx, lg, cmd, fmt.Errorf("marshal transcript: %w", err))
	}

	draft := ingest.TrackDraft{TitleRaw: cmd.Title, LangHint: raw.Language}
	if draft, err = s.d.Reviewer.Review(ctx, draft); err != nil {
		return s.fail(ctx, lg, cmd, fmt.Errorf("review: %w", err))
	}
	lang := draft.Lang

	stage = time.Now()
	aKey, tKey := audioKey(hash), transcriptKey(hash, lang)
	if err := s.d.Blob.Put(ctx, aKey, audio, "audio/mpeg"); err != nil {
		return s.fail(ctx, lg, cmd, fmt.Errorf("put audio: %w", err))
	}
	if err := s.d.Blob.Put(ctx, tKey, transcriptBody, "application/json"); err != nil {
		return s.fail(ctx, lg, cmd, fmt.Errorf("put transcript: %w", err))
	}

	// HEAD-verify both artifacts before announcing the track.
	for _, k := range []string{aKey, tKey} {
		exists, err := s.d.Blob.Exists(ctx, k)
		if err != nil {
			return s.fail(ctx, lg, cmd, fmt.Errorf("verify %s: %w", k, err))
		}
		if !exists {
			return s.fail(ctx, lg, cmd, fmt.Errorf("verify %s: missing after put", k))
		}
	}
	lg.InfoContext(ctx, "ingest_stored",
		"duration_ms", ms(stage), "blocks", len(reviewed.Blocks),
		"audio_key", aKey, "transcript_key", tKey)

	lg.InfoContext(ctx, "ingest_ready", "lang", lang, "total_ms", ms(started))
	return s.done(ctx, ingest.Result{
		JobID:         cmd.JobID,
		RequestID:     cmd.RequestID,
		Attempt:       cmd.Attempt,
		Phase:         ingest.PhaseReady,
		TrackID:       hash,
		Lang:          lang,
		Title:         draft.TitleRaw,
		AudioKey:      aKey,
		TranscriptKey: tKey,
		SourceURL:     cmd.URL,
	})
}

// fail publishes a terminal failed result (classifying transient vs permanent).
// It returns the publish error (if any) so a lost terminal result redelivers;
// the orchestrator decides re-dispatch from the Retriable flag and its cap.
//
// Log level splits on the SAME classification: a permanent failure is a business
// outcome (a dead or private URL — the user's problem, not ours) and logs at
// Warn, while a retriable one means our own dependency misbehaved and logs at
// Error. That keeps a corpus-wide "error rate" signal meaningful instead of
// drowning it in bad links.
func (s *Service) fail(ctx context.Context, lg *slog.Logger, cmd ingest.WorkCommand, cause error) error {
	retry := retriable(cause)
	lvl := slog.LevelError
	if !retry {
		lvl = slog.LevelWarn
	}
	lg.Log(ctx, lvl, "ingest_failed", "error", cause.Error(), "retriable", retry)
	return s.done(ctx, ingest.Result{
		JobID:     cmd.JobID,
		RequestID: cmd.RequestID,
		Attempt:   cmd.Attempt,
		Phase:     ingest.PhaseFailed,
		Error:     cause.Error(),
		Retriable: retry,
	})
}

// ms reports elapsed milliseconds for a stage timing attribute.
func ms(since time.Time) int64 { return time.Since(since).Milliseconds() }

// done publishes a TERMINAL result and propagates the publish error: the worker
// acks only once the outcome is durable (a publish fault → redelivery re-runs).
func (s *Service) done(ctx context.Context, r ingest.Result) error {
	return s.d.Results.Publish(ctx, r)
}

// emit publishes a NON-terminal heartbeat, best-effort: a publish failure is not
// fatal because the terminal result still carries the outcome.
func (s *Service) emit(ctx context.Context, r ingest.Result) {
	_ = s.d.Results.Publish(ctx, r)
}

// retriable classifies a pipeline error. Clearly-permanent failures — an
// unsupported/invalid URL, a deleted/private/age-restricted source, a 4xx, or a
// source that exceeds the size/duration limits — are wrapped with
// ingest.ErrPermanent by the fetch adapter and reported non-retriable
// (re-running can't help). Everything else (network blips, 5xx, timeouts,
// transcribe/put faults) is transient, so the orchestrator may re-dispatch.
func retriable(err error) bool {
	return !errors.Is(err, ingest.ErrPermanent)
}

// --- blob keys (content-addressed public path; identical to the MCP pipeline) ---

func audioKey(trackID string) string { return "public/tracks/" + trackID + "/audio/original.mp3" }
func transcriptKey(trackID, lang string) string {
	return "public/tracks/" + trackID + "/transcripts/" + lang + ".json"
}
