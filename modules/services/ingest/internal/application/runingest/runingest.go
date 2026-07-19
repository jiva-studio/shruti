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
	"os"
	"path/filepath"

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
		return nil // poison pill — unparseable; ack to drop it
	}

	// Best-effort heartbeat: moves the orchestrator's job queued → running.
	s.emit(ctx, ingest.Result{JobID: cmd.JobID, Attempt: cmd.Attempt, Phase: ingest.PhaseProcessing})

	localPath, hash, err := s.d.Fetcher.Fetch(ctx, cmd.URL)
	if err != nil {
		return s.fail(ctx, cmd, fmt.Errorf("fetch: %w", err))
	}
	defer os.RemoveAll(filepath.Dir(localPath))

	audio, err := os.ReadFile(localPath)
	if err != nil {
		return s.fail(ctx, cmd, fmt.Errorf("read audio: %w", err))
	}

	raw, _, err := s.d.Transcriber.Transcribe(ctx, localPath)
	if err != nil {
		return s.fail(ctx, cmd, fmt.Errorf("transcribe: %w", err))
	}
	raw.TrackId = hash
	if raw.Language == "" {
		raw.Language = "und" // keep the transcripts/<lang>.json key well-formed
	}

	// Window the raw ASR segments into the reviewed artifact the corpus/app read
	// (transcript.Reviewed — the exact shape + key the MCP pipeline stores).
	reviewed := s.d.Reviewer.NormalizeTranscript(raw)
	transcriptBody, err := json.Marshal(reviewed)
	if err != nil {
		return s.fail(ctx, cmd, fmt.Errorf("marshal transcript: %w", err))
	}

	draft := ingest.TrackDraft{TitleRaw: cmd.Title, LangHint: raw.Language}
	if draft, err = s.d.Reviewer.Review(ctx, draft); err != nil {
		return s.fail(ctx, cmd, fmt.Errorf("review: %w", err))
	}
	lang := draft.Lang

	aKey, tKey := audioKey(hash), transcriptKey(hash, lang)
	if err := s.d.Blob.Put(ctx, aKey, audio, "audio/mpeg"); err != nil {
		return s.fail(ctx, cmd, fmt.Errorf("put audio: %w", err))
	}
	if err := s.d.Blob.Put(ctx, tKey, transcriptBody, "application/json"); err != nil {
		return s.fail(ctx, cmd, fmt.Errorf("put transcript: %w", err))
	}

	// HEAD-verify both artifacts before announcing the track.
	for _, k := range []string{aKey, tKey} {
		exists, err := s.d.Blob.Exists(ctx, k)
		if err != nil {
			return s.fail(ctx, cmd, fmt.Errorf("verify %s: %w", k, err))
		}
		if !exists {
			return s.fail(ctx, cmd, fmt.Errorf("verify %s: missing after put", k))
		}
	}

	return s.done(ctx, ingest.Result{
		JobID:         cmd.JobID,
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
func (s *Service) fail(ctx context.Context, cmd ingest.WorkCommand, cause error) error {
	return s.done(ctx, ingest.Result{
		JobID:     cmd.JobID,
		Attempt:   cmd.Attempt,
		Phase:     ingest.PhaseFailed,
		Error:     cause.Error(),
		Retriable: retriable(cause),
	})
}

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
