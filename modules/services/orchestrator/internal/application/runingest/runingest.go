// Package runingest is the orchestrator's coordination core. The orchestrator
// is a THIN coordinator: it does NOT fetch, transcribe, or store anything —
// that is the stateless `ingest` worker's job. This package holds the two
// broker handlers that make up the seam:
//
//   - RequestHandler consumes `ingest.request` (chat → orchestrator): it
//     creates the job, re-verifies the PRO tier, and — in ONE transaction —
//     commits the job, a `track.queued` outbox event, and an `ingest.work`
//     outbox command that dispatches the heavy lifting to the ingest worker.
//   - ResultHandler consumes `ingest.result` (ingest → orchestrator): it maps
//     the worker's phase reports (processing / ready / failed) onto job state
//     transitions and the `track.events` lifecycle, and owns the RETRY policy —
//     a retriable failure below the attempt cap re-dispatches a fresh
//     `ingest.work`; otherwise the job dead-letters with `track.failed`.
//
// Guarantees:
//   - The job is the source of truth. Its id is derived deterministically
//     (UUIDv5) from the `ingest.request` message id, so a redelivered request
//     maps to the SAME job (idempotent create).
//   - `track.events` ids are derived from the JOB id (not the broker message
//     id), so queued/processing/ready/failed for one job are stable across the
//     two streams and any redelivery — downstream projections stay idempotent.
//   - Everything is driven through ports, so the whole seam is exercised with
//     fakes (no Postgres, no broker).
package runingest

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/orchestrator/internal/domain/ingest"
	"github.com/jiva-studio/shruti/orchestrator/internal/domain/job"
	"github.com/jiva-studio/shruti/orchestrator/internal/ports"
)

// jobNamespace seeds the deterministic (UUIDv5) job id derived from a message
// id, so redelivery is idempotent at the job level.
var jobNamespace = uuid.MustParse("1b671a64-40d5-491e-99b0-da01ff1f3341")

// errUnauthorized is a permanent (non-retryable) failure: the request's token
// no longer grants an active PRO tier.
var errUnauthorized = errors.New("pro tier not verified")

// Deps bundles the ports both handlers share.
type Deps struct {
	Repo   ports.JobRepository
	Events ports.EventBus
	Tier   ports.TierVerifier

	MaxAttempts       int
	TrackEventsStream string
	WorkStream        string
}

func (d *Deps) applyDefaults() {
	if d.MaxAttempts <= 0 {
		d.MaxAttempts = 5
	}
	if d.TrackEventsStream == "" {
		d.TrackEventsStream = "track.events"
	}
	if d.WorkStream == "" {
		d.WorkStream = "ingest.work"
	}
}

// core carries the shared deps + helpers the two handlers reuse.
type core struct{ d Deps }

// RequestHandler processes `ingest.request` (chat → orchestrator).
type RequestHandler struct{ core }

// NewRequestHandler builds the request handler, defaulting the attempt cap and
// stream names.
func NewRequestHandler(d Deps) *RequestHandler {
	d.applyDefaults()
	return &RequestHandler{core{d}}
}

// Process handles one `ingest.request`. It returns nil when the entry is safe
// to XACK and a non-nil error only to leave it pending for redelivery (a
// transient persistence fault). No pipeline work happens here — the job is
// created and the heavy lifting is dispatched to the ingest worker.
func (h *RequestHandler) Process(ctx context.Context, msgID string, payload []byte) error {
	req, err := ingest.DecodeRequest(payload)
	if err != nil {
		// The only path with no job_id to correlate on — log it, or a malformed
		// producer silently drops every request it sends.
		slog.WarnContext(ctx, "request_poison_pill", "error", err.Error(), "msg_id", msgID)
		return nil // unparseable; ack to drop it
	}

	jobID := uuid.NewSHA1(jobNamespace, []byte(msgID)).String()
	lg := slog.With("job_id", jobID, "request_id", req.RequestID)
	existing, err := h.d.Repo.Get(ctx, jobID)
	if err != nil {
		return fmt.Errorf("load job: %w", err)
	}
	// A job for this request already exists — settled or in flight. Ack without
	// touching it: PRO was verified when it was created, and any retry belongs to
	// the ResultHandler. (Re-verifying here would let a token that lapsed AFTER
	// acceptance fail a job whose ingest.work is still in flight.)
	if existing != nil {
		lg.InfoContext(ctx, "request_duplicate", "state", string(existing.State))
		return nil
	}

	// First time we see this request: verify PRO from the JWT. A lapsed / invalid
	// token is a PERMANENT failure — create a failed job, emit track.failed, ack.
	userID, pro, verr := h.d.Tier.VerifyPro(req.Token)
	if verr != nil || !pro {
		lg.WarnContext(ctx, "request_rejected_not_pro", "user_id", req.UserID)
		return h.failNotPro(ctx, jobID, req, payload)
	}

	owner := req.UserID
	if owner == "" {
		owner = userID
	}
	j := &job.Job{
		ID:      jobID,
		Kind:    job.KindLibraryIngest,
		OwnerID: owner,
		State:   job.StateQueued,
		Spec:    payload,
	}
	lg.InfoContext(ctx, "job_created", "user_id", owner, "url", req.URL)
	// One tx: the job row + the track.queued event + the ingest.work dispatch
	// all commit together (transactional outbox), so the worker is invoked iff
	// the job was durably created.
	return h.d.Repo.WithTx(ctx, func(tx ports.Tx) error {
		if err := h.d.Repo.CreateTx(ctx, tx, j); err != nil {
			return err
		}
		queued := event(jobID+":queued", ingest.EventQueued, req.RequestID, owner, jobID, "", statusData("queued", req.Title))
		if err := h.publishEvent(ctx, tx, queued); err != nil {
			return err
		}
		return h.dispatchWork(ctx, tx, jobID, owner, req, 1)
	})
}

// failNotPro settles a brand-new job that failed PRO verification: create it
// directly in the failed state, emit track.failed (id job:failed), and ack.
// Only reached for a request with no existing job (an in-flight/settled job is
// never re-judged), so the job is always new.
func (h *RequestHandler) failNotPro(ctx context.Context, jobID string, req ingest.Request, payload []byte) error {
	j := &job.Job{
		ID:      jobID,
		Kind:    job.KindLibraryIngest,
		OwnerID: req.UserID,
		State:   job.StateQueued,
		Spec:    payload,
	}
	if err := j.To(job.StateFailed); err != nil {
		return fmt.Errorf("to failed: %w", err)
	}
	j.Err = errUnauthorized.Error()
	ev := event(jobID+":failed", ingest.EventFailed, req.RequestID, j.OwnerID, jobID, j.TrackID, failData(errUnauthorized.Error(), req.Title))
	return h.d.Repo.WithTx(ctx, func(tx ports.Tx) error {
		if err := h.d.Repo.CreateTx(ctx, tx, j); err != nil {
			return err
		}
		return h.publishEvent(ctx, tx, ev)
	})
}

// ResultHandler processes `ingest.result` (ingest → orchestrator).
type ResultHandler struct{ core }

// NewResultHandler builds the result handler, defaulting the attempt cap and
// stream names.
func NewResultHandler(d Deps) *ResultHandler {
	d.applyDefaults()
	return &ResultHandler{core{d}}
}

// Process handles one `ingest.result`. The job is loaded by result.JobID (NOT
// the broker message id). It returns nil to XACK; a non-nil error leaves the
// entry pending for a transient persistence fault.
func (h *ResultHandler) Process(ctx context.Context, _ string, payload []byte) error {
	res, err := ingest.DecodeResult(payload)
	if err != nil {
		slog.WarnContext(ctx, "result_poison_pill", "error", err.Error())
		return nil // unparseable; ack to drop it
	}
	lg := slog.With("job_id", res.JobID, "request_id", res.RequestID, "attempt", res.Attempt)
	j, err := h.d.Repo.Get(ctx, res.JobID)
	if err != nil {
		return fmt.Errorf("load job: %w", err)
	}
	if j == nil {
		// A result for a job we have no row for: the worker outlived a job the
		// orchestrator never committed, or the streams were reset out from under
		// it. Silent-dropping this made the pipeline look idle for no reason.
		lg.WarnContext(ctx, "result_unknown_job")
		return nil
	}
	if isSettled(j) {
		return nil // already terminal — idempotent ack
	}

	switch res.Phase {
	case ingest.PhaseProcessing:
		if j.State != job.StateQueued {
			return nil // already running — no-op
		}
		if err := j.To(job.StateRunning); err != nil {
			return fmt.Errorf("to running: %w", err)
		}
		ev := event(res.JobID+":processing", ingest.EventProcessing, res.RequestID, j.OwnerID, res.JobID, "", statusData("processing", specRequest(j).Title))
		return h.save(ctx, j, ev)

	case ingest.PhaseReady:
		j.TrackID = res.TrackID
		j.Result = readyResult(res)
		// A ready may arrive while the job is still queued (a lost processing
		// heartbeat) — step it through running so To(Done) is legal.
		if j.State == job.StateQueued {
			_ = j.To(job.StateRunning)
		}
		if err := j.To(job.StateDone); err != nil {
			return fmt.Errorf("to done: %w", err)
		}
		// Key the projection on the JOB id (the stable library membership id) —
		// the SAME doc_id as queued/processing/failed — so the row advances in
		// place; the content hash rides along in track_id (via j.Result / the
		// TrackEvent.TrackID field), not as the key.
		lg.InfoContext(ctx, "job_done", "track_id", res.TrackID, "lang", res.Lang)
		ev := event(res.JobID+":ready", ingest.EventReady, res.RequestID, j.OwnerID, res.JobID, res.TrackID, j.Result)
		return h.save(ctx, j, ev)

	case ingest.PhaseFailed:
		// Discard a stale/duplicate failed result. The in-flight attempt is
		// j.Attempts+1 (the last dispatched ingest.work); a redelivered failure
		// from an already-superseded attempt (res.Attempt < that) must NOT
		// re-dispatch again or double-count — the newer attempt owns the job now.
		// (This is a cheap pre-filter; the authoritative check is under the row
		// lock below so concurrent redelivery can't double-dispatch.)
		if res.Attempt != j.Attempts+1 {
			return nil
		}
		// Retry policy lives HERE: a retriable failure below the cap re-dispatches
		// a fresh ingest.work. Re-load the job FOR UPDATE inside the tx and
		// re-check under the lock, so two consumers racing the same result can't
		// both increment + dispatch (the loser sees the bumped attempt and no-ops).
		if res.Retriable && j.Attempts < h.d.MaxAttempts {
			return h.d.Repo.WithTx(ctx, func(tx ports.Tx) error {
				locked, err := h.d.Repo.GetForUpdateTx(ctx, tx, res.JobID)
				if err != nil {
					return err
				}
				if locked == nil || locked.State.IsTerminal() {
					return nil // already settled by another consumer
				}
				if res.Attempt != locked.Attempts+1 {
					return nil // superseded under the lock — do not re-dispatch
				}
				locked.Attempts++
				req := specRequest(locked)
				if err := h.d.Repo.SaveTx(ctx, tx, locked); err != nil {
					return err
				}
				next := locked.Attempts + 1
				lg.WarnContext(ctx, "job_retry_scheduled",
					"error", res.Error, "next_attempt", next,
					"max_attempts", h.d.MaxAttempts,
					"backoff_ms", retryBackoff(next).Milliseconds())
				return h.dispatchWork(ctx, tx, res.JobID, locked.OwnerID, req, next)
			})
		}
		if !j.State.IsTerminal() {
			if err := j.To(job.StateFailed); err != nil {
				return fmt.Errorf("to failed: %w", err)
			}
		}
		j.Err = res.Error
		// Dead-letter. Log at Error regardless of the worker's retriable flag:
		// reaching here means the user's track is permanently lost, which is an
		// operational event even when the cause was "the link was dead". The
		// `exhausted` field separates "we burned the attempt budget" (our
		// dependency is sick) from "the source was never ingestable".
		lg.ErrorContext(ctx, "job_dead_lettered",
			"error", res.Error, "attempts", j.Attempts,
			"exhausted", res.Retriable, "user_id", j.OwnerID)
		ev := event(res.JobID+":failed", ingest.EventFailed, res.RequestID, j.OwnerID, res.JobID, j.TrackID, failData(res.Error, specRequest(j).Title))
		return h.save(ctx, j, ev)

	default:
		return nil // unknown phase — ignore
	}
}

// --- shared helpers ---

// isSettled reports whether a loaded job needs no further work. A retriable
// failure keeps the job non-terminal (it is re-dispatched, not transitioned),
// so any terminal state is genuinely settled.
func isSettled(j *job.Job) bool { return j.State.IsTerminal() }

// save persists a job update and its outbox events in one tx.
func (c *core) save(ctx context.Context, j *job.Job, events ...ingest.TrackEvent) error {
	return c.d.Repo.WithTx(ctx, func(tx ports.Tx) error {
		if err := c.d.Repo.SaveTx(ctx, tx, j); err != nil {
			return err
		}
		for _, e := range events {
			if err := c.publishEvent(ctx, tx, e); err != nil {
				return err
			}
		}
		return nil
	})
}

// publishEvent enqueues a track.events lifecycle event on the outbox.
func (c *core) publishEvent(ctx context.Context, tx ports.Tx, e ingest.TrackEvent) error {
	b, err := e.Marshal()
	if err != nil {
		return err
	}
	return c.d.Events.Publish(ctx, tx, c.d.TrackEventsStream, b)
}

// dispatchWork enqueues an ingest.work command on the outbox (topic
// WorkStream), reliably fanned out to the ingest worker by the same relay. A
// retry (attempt >= 2) is stamped with a backoff so a transient outage isn't
// burned through; the first attempt dispatches immediately.
// It takes the whole Request rather than loose fields so the correlation id
// travels with the URL/title automatically — a retry recovers all three from
// the job's stored spec and cannot silently drop the id.
func (c *core) dispatchWork(ctx context.Context, tx ports.Tx, jobID, owner string, req ingest.Request, attempt int) error {
	b, err := ingest.WorkCommand{
		JobID:     jobID,
		RequestID: req.RequestID,
		URL:       req.URL,
		Title:     req.Title,
		Author:    req.Author,
		OwnerID:   owner,
		Attempt:   attempt,
	}.Marshal()
	if err != nil {
		return err
	}
	return c.d.Events.PublishAfter(ctx, tx, c.d.WorkStream, b, retryBackoff(attempt))
}

// retryBackoff is the not-before delay before an ingest.work dispatch for a
// given attempt number. The first attempt is immediate; a retry waits an
// exponential backoff (attempt 2→15s, 3→30s, 4→60s, then capped at 2m) so a
// brief upstream outage — or an open yt-dlp circuit breaker serving its ~30s
// cooldown — doesn't consume the whole (default 5) attempt budget in
// milliseconds. Capped so a job still dead-letters in bounded time.
func retryBackoff(attempt int) time.Duration {
	if attempt <= 1 {
		return 0
	}
	const maxBackoff = 2 * time.Minute
	shift := attempt - 2
	if shift > 4 { // 15s<<4 = 240s already past the cap; also avoids int64 overflow
		return maxBackoff
	}
	d := 15 * time.Second << uint(shift)
	if d > maxBackoff {
		d = maxBackoff
	}
	return d
}

// event builds a lifecycle event. Its ID is derived from the JOB id + type so
// redelivery (on either stream) re-emits the SAME id, keeping downstream
// projections idempotent.
func event(id, typ, requestID, userID, docID, trackID string, data []byte) ingest.TrackEvent {
	return ingest.TrackEvent{
		ID:        id,
		Type:      typ,
		RequestID: requestID,
		UserID:    userID,
		DocID:     docID,
		TrackID:   trackID,
		Data:      data,
	}
}

// --- spec / payload helpers ---

// specRequest recovers the original ingest.request from the job's Spec (used to
// recover the URL/title when re-dispatching a retry).
func specRequest(j *job.Job) ingest.Request {
	req, _ := ingest.DecodeRequest(j.Spec)
	return req
}
