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
//     crash before XACK) re-runs safely and converges on the same keys.
//   - Dedup: if identical audio was already stored by a prior job, the owner is
//     LINKED to it (phase "linked") instead of re-transcribing.
//   - The worker emits EXACTLY ONE terminal result (ready | linked | failed)
//     and then ALWAYS acks. It never retries and never tracks attempts — the
//     retry policy (and the attempt cap) lives entirely in the orchestrator,
//     which decides whether a failed result is re-dispatched.
package runingest

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/jiva-studio/lectorium/ingest/internal/domain/ingest"
	"github.com/jiva-studio/lectorium/ingest/internal/ports"
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

// Process handles one `ingest.work` message. It ALWAYS returns nil (safe to
// XACK) once it has emitted a terminal result: the worker does not leave entries
// pending for its own retry — the orchestrator owns retries. A non-decodable
// payload is a poison pill and is dropped (nil, no result).
func (s *Service) Process(ctx context.Context, _ string, payload []byte) error {
	cmd, err := ingest.DecodeWork(payload)
	if err != nil {
		return nil // poison pill — unparseable; ack to drop it
	}

	// Best-effort heartbeat: moves the orchestrator's job queued → running.
	s.emit(ctx, ingest.Result{JobID: cmd.JobID, Phase: ingest.PhaseProcessing})

	localPath, hash, err := s.d.Fetcher.Fetch(ctx, cmd.URL)
	if err != nil {
		return s.fail(ctx, cmd, fmt.Errorf("fetch: %w", err))
	}
	defer os.RemoveAll(filepath.Dir(localPath))

	// Dedup on the artifact itself: if this exact content was already ingested
	// and STORED by a prior job, the blob is present — link this owner to it
	// instantly instead of re-transcribing.
	already, err := s.d.Blob.Exists(ctx, audioKey(hash))
	if err != nil {
		return s.fail(ctx, cmd, fmt.Errorf("dedup probe: %w", err))
	}
	if already {
		s.emit(ctx, ingest.Result{
			JobID:         cmd.JobID,
			Phase:         ingest.PhaseLinked,
			TrackID:       hash,
			Title:         cmd.Title,
			AudioKey:      audioKey(hash),
			TranscriptKey: transcriptKey(hash),
			SourceURL:     cmd.URL,
		})
		return nil
	}

	audio, err := os.ReadFile(localPath)
	if err != nil {
		return s.fail(ctx, cmd, fmt.Errorf("read audio: %w", err))
	}

	transcript, lang, err := s.d.Transcriber.Transcribe(ctx, localPath)
	if err != nil {
		return s.fail(ctx, cmd, fmt.Errorf("transcribe: %w", err))
	}

	draft := ingest.TrackDraft{TitleRaw: cmd.Title, LangHint: lang}
	if draft, err = s.d.Reviewer.Review(ctx, draft); err != nil {
		return s.fail(ctx, cmd, fmt.Errorf("review: %w", err))
	}

	aKey, tKey := audioKey(hash), transcriptKey(hash)
	if err := s.d.Blob.Put(ctx, aKey, audio, "audio/mpeg"); err != nil {
		return s.fail(ctx, cmd, fmt.Errorf("put audio: %w", err))
	}
	if err := s.d.Blob.Put(ctx, tKey, transcript, "application/json"); err != nil {
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

	s.emit(ctx, ingest.Result{
		JobID:         cmd.JobID,
		Phase:         ingest.PhaseReady,
		TrackID:       hash,
		Lang:          draft.Lang,
		Title:         draft.TitleRaw,
		AudioKey:      aKey,
		TranscriptKey: tKey,
		SourceURL:     cmd.URL,
	})
	return nil
}

// fail emits a terminal failed result (classifying transient vs permanent) and
// acks. The worker never retries — the orchestrator decides re-dispatch from
// the Retriable flag and its own attempt cap.
func (s *Service) fail(ctx context.Context, cmd ingest.WorkCommand, cause error) error {
	s.emit(ctx, ingest.Result{
		JobID:     cmd.JobID,
		Phase:     ingest.PhaseFailed,
		Error:     cause.Error(),
		Retriable: retriable(cause),
	})
	return nil
}

// emit publishes a result, best-effort: a publish failure is not fatal because
// the content-addressed keys make a redelivered re-run idempotent.
func (s *Service) emit(ctx context.Context, r ingest.Result) {
	_ = s.d.Results.Publish(ctx, r)
}

// retriable classifies a pipeline error. Clearly-permanent failures — an
// unsupported/invalid URL, a 404, or a source that exceeds the size/duration
// limits — are non-retriable (re-running can't help). Everything else
// (network blips, 5xx, timeouts, transcribe/put faults) is transient.
func retriable(err error) bool {
	msg := err.Error()
	for _, permanent := range []string{"invalid url", "status 404", "exceeds limit"} {
		if strings.Contains(msg, permanent) {
			return false
		}
	}
	return true
}

// --- blob keys (content-addressed public path) ---

func audioKey(trackID string) string      { return "public/tracks/" + trackID + "/audio" }
func transcriptKey(trackID string) string { return "public/tracks/" + trackID + "/transcript" }
