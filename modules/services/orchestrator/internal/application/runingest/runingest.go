// Package runingest is the ingest pipeline use case: it consumes one
// `ingest.request`, drives it through fetch → content-hash → transcribe →
// review → store, and emits the `track.*` lifecycle via the transactional
// outbox. It depends ONLY on ports, so the whole flow is exercised with fakes.
//
// Guarantees:
//   - Job is the source of truth. The job id is derived deterministically from
//     the broker message id, so a redelivered message maps to the SAME job
//     (idempotent create; attempts accumulate for the dead-letter cap).
//   - PRO tier is RE-VERIFIED from the request JWT at processing time.
//   - Dedup on the stored artifact: if identical audio was already ingested and
//     its blob is present, the new owner is linked to it instead of
//     re-transcribing — and a track is never announced before its blob exists.
//   - At-least-once: on a transient failure the message is left pending
//     (Process returns an error) until MaxAttempts, then the job dead-letters
//     (marked failed, `track.failed` emitted) and the message is acked.
package runingest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/google/uuid"

	"github.com/jiva-studio/lectorium/orchestrator/internal/domain/ingest"
	"github.com/jiva-studio/lectorium/orchestrator/internal/domain/job"
	"github.com/jiva-studio/lectorium/orchestrator/internal/ports"
)

// jobNamespace seeds the deterministic (UUIDv5) job id derived from a message
// id, so redelivery is idempotent at the job level.
var jobNamespace = uuid.MustParse("1b671a64-40d5-491e-99b0-da01ff1f3341")

// Deps bundles the ports the use case needs.
type Deps struct {
	Repo        ports.JobRepository
	Events      ports.EventBus
	Fetcher     ports.Fetcher
	Transcriber ports.Transcriber
	Reviewer    ports.Reviewer
	Blob        ports.BlobStore
	Tier        ports.TierVerifier
	Clock       ports.Clock
	IDs         ports.IDGen

	MaxAttempts       int
	TrackEventsStream string
}

// Service runs the pipeline.
type Service struct {
	d Deps
}

// New builds a Service, defaulting the attempt cap and stream name.
func New(d Deps) *Service {
	if d.MaxAttempts <= 0 {
		d.MaxAttempts = 5
	}
	if d.TrackEventsStream == "" {
		d.TrackEventsStream = "track.events"
	}
	return &Service{d: d}
}

// errUnauthorized is a permanent (non-retryable) failure: the request's token
// no longer grants an active PRO tier.
var errUnauthorized = errors.New("pro tier not verified")

// Process handles one message. It returns nil when the entry is safe to XACK
// (success, dedup, permanent failure, or dead-letter) and a non-nil error to
// leave the entry pending for redelivery (a retryable transient failure).
func (s *Service) Process(ctx context.Context, msgID string, payload []byte) error {
	req, err := ingest.DecodeRequest(payload)
	if err != nil {
		// Poison pill — unparseable. Ack to drop it (redelivery can't help).
		return nil
	}

	jobID := uuid.NewSHA1(jobNamespace, []byte(msgID)).String()
	existing, err := s.d.Repo.Get(ctx, jobID)
	if err != nil {
		return fmt.Errorf("load job: %w", err)
	}
	if existing != nil && s.isSettled(existing) {
		return nil // already terminal — idempotent ack
	}

	j := existing
	if j == nil {
		j = &job.Job{
			ID:      jobID,
			Kind:    job.KindLibraryIngest,
			OwnerID: req.UserID,
			State:   job.StateQueued,
			Spec:    payload,
		}
		if err := s.create(ctx, j, s.event(msgID, ingest.EventQueued, j.OwnerID, jobID, "", statusData("queued", req.URL))); err != nil {
			return fmt.Errorf("create job: %w", err)
		}
	}

	// Re-verify PRO from the JWT. A lapsed / invalid token is a PERMANENT
	// failure: fail the job, emit track.failed, and ack (no retry helps).
	userID, pro, verr := s.d.Tier.VerifyPro(req.Token)
	if verr != nil || !pro {
		return s.deadLetter(ctx, msgID, j, errUnauthorized)
	}
	if j.OwnerID == "" {
		j.OwnerID = userID
	}

	return s.run(ctx, msgID, j, req)
}

// run executes the fetch→store pipeline for a verified request.
func (s *Service) run(ctx context.Context, msgID string, j *job.Job, req ingest.Request) error {
	prev := j.State
	if err := j.To(job.StateRunning); err != nil {
		return fmt.Errorf("to running: %w", err)
	}
	j.Attempts++
	var events []ingest.TrackEvent
	if prev == job.StateQueued {
		events = append(events, s.event(msgID, ingest.EventProcessing, j.OwnerID, j.ID, "", statusData("processing", req.URL)))
	}
	if err := s.save(ctx, j, events...); err != nil {
		return fmt.Errorf("save running: %w", err)
	}

	localPath, hash, err := s.d.Fetcher.Fetch(ctx, req.URL)
	if err != nil {
		return s.retryOrDead(ctx, msgID, j, fmt.Errorf("fetch: %w", err))
	}
	defer os.RemoveAll(filepath.Dir(localPath))

	// Dedup on the artifact itself: if this exact content was already ingested
	// and STORED by a prior job, the blob is present — link this owner to it
	// instantly instead of re-transcribing. Keying on the verified blob (not a
	// speculative claim) means we never announce a track whose bytes are
	// missing, and a failed prior job leaves nothing to unblock: it simply
	// didn't store the blob, so the next request re-processes normally. Two
	// genuinely-simultaneous first ingests of new content both process and both
	// write the same content-addressed keys (idempotent) — wasteful but correct.
	already, err := s.d.Blob.Exists(ctx, audioKey(hash))
	if err != nil {
		return s.retryOrDead(ctx, msgID, j, fmt.Errorf("dedup probe: %w", err))
	}
	if already {
		return s.finishDedup(ctx, msgID, j, hash, req)
	}

	audio, err := os.ReadFile(localPath)
	if err != nil {
		return s.retryOrDead(ctx, msgID, j, fmt.Errorf("read audio: %w", err))
	}

	transcript, lang, err := s.d.Transcriber.Transcribe(ctx, localPath)
	if err != nil {
		return s.retryOrDead(ctx, msgID, j, fmt.Errorf("transcribe: %w", err))
	}

	draft := ingest.TrackDraft{TitleRaw: req.Title, LangHint: lang}
	if draft, err = s.d.Reviewer.Review(ctx, draft); err != nil {
		return s.retryOrDead(ctx, msgID, j, fmt.Errorf("review: %w", err))
	}

	audioKey, transcriptKey := audioKey(hash), transcriptKey(hash)
	if err := s.d.Blob.Put(ctx, audioKey, audio, "audio/mpeg"); err != nil {
		return s.retryOrDead(ctx, msgID, j, fmt.Errorf("put audio: %w", err))
	}
	if err := s.d.Blob.Put(ctx, transcriptKey, transcript, "application/json"); err != nil {
		return s.retryOrDead(ctx, msgID, j, fmt.Errorf("put transcript: %w", err))
	}

	// HEAD-verify both artifacts before announcing the track.
	for _, k := range []string{audioKey, transcriptKey} {
		exists, err := s.d.Blob.Exists(ctx, k)
		if err != nil {
			return s.retryOrDead(ctx, msgID, j, fmt.Errorf("verify %s: %w", k, err))
		}
		if !exists {
			return s.retryOrDead(ctx, msgID, j, fmt.Errorf("verify %s: missing after put", k))
		}
	}

	return s.finishReady(ctx, msgID, j, hash, lang, draft, req)
}

// finishReady marks the job done and emits track.ready.
func (s *Service) finishReady(ctx context.Context, msgID string, j *job.Job, hash, lang string, draft ingest.TrackDraft, req ingest.Request) error {
	j.TrackID = hash
	j.Result = readyResult(hash, lang, draft, req)
	if err := j.To(job.StateDone); err != nil {
		return fmt.Errorf("to done: %w", err)
	}
	ev := s.event(msgID, ingest.EventReady, j.OwnerID, hash, hash, j.Result)
	if err := s.save(ctx, j, ev); err != nil {
		return fmt.Errorf("save done: %w", err)
	}
	return nil
}

// finishDedup collapses this job onto content whose blob is already stored
// (verified present by the Exists probe in run), linking this owner instantly.
func (s *Service) finishDedup(ctx context.Context, msgID string, j *job.Job, hash string, req ingest.Request) error {
	j.TrackID = hash
	j.Result = readyResult(hash, "", ingest.TrackDraft{TitleRaw: req.Title}, req)
	if err := j.To(job.StateDone); err != nil {
		return fmt.Errorf("to done (dedup): %w", err)
	}
	ev := s.event(msgID, ingest.EventReady, j.OwnerID, hash, hash, j.Result)
	if err := s.save(ctx, j, ev); err != nil {
		return fmt.Errorf("save dedup: %w", err)
	}
	return nil
}

// retryOrDead records a pipeline error. Below the attempt cap it returns the
// error so the message is redelivered; at the cap it dead-letters.
func (s *Service) retryOrDead(ctx context.Context, msgID string, j *job.Job, cause error) error {
	if j.Attempts >= s.d.MaxAttempts {
		return s.deadLetter(ctx, msgID, j, cause)
	}
	j.Err = cause.Error()
	if err := s.save(ctx, j); err != nil {
		return fmt.Errorf("save retry: %w", err)
	}
	return cause // leave pending → redelivered
}

// deadLetter transitions the job to failed, emits track.failed, and acks.
func (s *Service) deadLetter(ctx context.Context, msgID string, j *job.Job, cause error) error {
	if !j.State.IsTerminal() {
		if err := j.To(job.StateFailed); err != nil {
			return fmt.Errorf("to failed: %w", err)
		}
	}
	j.Err = cause.Error()
	ev := s.event(msgID, ingest.EventFailed, j.OwnerID, j.ID, j.TrackID, failData(cause))
	if err := s.save(ctx, j, ev); err != nil {
		return fmt.Errorf("save failed: %w", err)
	}
	return nil // acked — a dead-lettered job won't be retried
}

// isSettled reports whether a loaded job needs no further work: done, or failed
// after exhausting attempts.
func (s *Service) isSettled(j *job.Job) bool {
	switch j.State {
	case job.StateDone, job.StateCancelled:
		return true
	case job.StateFailed:
		return j.Attempts >= s.d.MaxAttempts
	default:
		return false
	}
}

// --- persistence helpers (job write + outbox events in one tx) ---

func (s *Service) create(ctx context.Context, j *job.Job, events ...ingest.TrackEvent) error {
	return s.d.Repo.WithTx(ctx, func(tx ports.Tx) error {
		if err := s.d.Repo.CreateTx(ctx, tx, j); err != nil {
			return err
		}
		return s.publish(ctx, tx, events)
	})
}

func (s *Service) save(ctx context.Context, j *job.Job, events ...ingest.TrackEvent) error {
	return s.d.Repo.WithTx(ctx, func(tx ports.Tx) error {
		if err := s.d.Repo.SaveTx(ctx, tx, j); err != nil {
			return err
		}
		return s.publish(ctx, tx, events)
	})
}

func (s *Service) publish(ctx context.Context, tx ports.Tx, events []ingest.TrackEvent) error {
	for _, e := range events {
		b, err := e.Marshal()
		if err != nil {
			return err
		}
		if err := s.d.Events.Publish(ctx, tx, s.d.TrackEventsStream, b); err != nil {
			return err
		}
	}
	return nil
}

// event builds a lifecycle event. Its ID is deterministic per (message, type)
// so redelivery re-emits the SAME id, keeping downstream projections idempotent.
func (s *Service) event(msgID, typ, userID, docID, trackID string, data []byte) ingest.TrackEvent {
	return ingest.TrackEvent{
		ID:      msgID + ":" + typ,
		Type:    typ,
		UserID:  userID,
		DocID:   docID,
		TrackID: trackID,
		Data:    data,
	}
}

// --- blob keys ---

func audioKey(trackID string) string      { return "public/tracks/" + trackID + "/audio" }
func transcriptKey(trackID string) string { return "public/tracks/" + trackID + "/transcript" }

// --- event/result payloads ---

func statusData(status, url string) []byte {
	b, _ := json.Marshal(map[string]any{"status": status, "url": url})
	return b
}

func failData(cause error) []byte {
	b, _ := json.Marshal(map[string]any{"status": "failed", "error": cause.Error()})
	return b
}

func readyResult(hash, lang string, draft ingest.TrackDraft, req ingest.Request) []byte {
	b, _ := json.Marshal(map[string]any{
		"status":         "ready",
		"track_id":       hash,
		"lang":           lang,
		"title":          draft.TitleRaw,
		"audio_key":      audioKey(hash),
		"transcript_key": transcriptKey(hash),
		"source_url":     req.URL,
	})
	return b
}
