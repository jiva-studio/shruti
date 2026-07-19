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
//     the worker's phase reports (processing / ready / linked / failed) onto job
//     state transitions and the `track.events` lifecycle, and owns the RETRY
//     policy — a retriable failure below the attempt cap re-dispatches a fresh
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
		return nil // poison pill — unparseable; ack to drop it
	}

	jobID := uuid.NewSHA1(jobNamespace, []byte(msgID)).String()
	existing, err := h.d.Repo.Get(ctx, jobID)
	if err != nil {
		return fmt.Errorf("load job: %w", err)
	}
	if existing != nil && isSettled(existing) {
		return nil // already terminal — idempotent ack
	}

	// Re-verify PRO from the JWT. A lapsed / invalid token is a PERMANENT
	// failure: create-or-fail the job, emit track.failed, and ack.
	userID, pro, verr := h.d.Tier.VerifyPro(req.Token)
	if verr != nil || !pro {
		return h.failNotPro(ctx, jobID, req, payload, existing)
	}

	// A non-settled job already exists → its ingest.work dispatch is in flight.
	// Do NOT re-dispatch (that is the ResultHandler's retry job).
	if existing != nil {
		return nil
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
	// One tx: the job row + the track.queued event + the ingest.work dispatch
	// all commit together (transactional outbox), so the worker is invoked iff
	// the job was durably created.
	return h.d.Repo.WithTx(ctx, func(tx ports.Tx) error {
		if err := h.d.Repo.CreateTx(ctx, tx, j); err != nil {
			return err
		}
		queued := event(jobID+":queued", ingest.EventQueued, owner, jobID, "", statusData("queued", req.URL))
		if err := h.publishEvent(ctx, tx, queued); err != nil {
			return err
		}
		return h.dispatchWork(ctx, tx, jobID, req.URL, req.Title, owner, 1)
	})
}

// failNotPro settles a job that failed PRO re-verification: create-or-transition
// to failed, emit track.failed (id job:failed), and ack.
func (h *RequestHandler) failNotPro(ctx context.Context, jobID string, req ingest.Request, payload []byte, existing *job.Job) error {
	j := existing
	isNew := j == nil
	if isNew {
		j = &job.Job{
			ID:      jobID,
			Kind:    job.KindLibraryIngest,
			OwnerID: req.UserID,
			State:   job.StateQueued,
			Spec:    payload,
		}
	}
	if !j.State.IsTerminal() {
		if err := j.To(job.StateFailed); err != nil {
			return fmt.Errorf("to failed: %w", err)
		}
	}
	j.Err = errUnauthorized.Error()
	ev := event(jobID+":failed", ingest.EventFailed, j.OwnerID, jobID, j.TrackID, failData(errUnauthorized.Error()))
	return h.d.Repo.WithTx(ctx, func(tx ports.Tx) error {
		if isNew {
			if err := h.d.Repo.CreateTx(ctx, tx, j); err != nil {
				return err
			}
		} else if err := h.d.Repo.SaveTx(ctx, tx, j); err != nil {
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
		return nil // poison pill — unparseable; ack to drop it
	}
	j, err := h.d.Repo.Get(ctx, res.JobID)
	if err != nil {
		return fmt.Errorf("load job: %w", err)
	}
	if j == nil {
		return nil // unknown job — nothing to do
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
		ev := event(res.JobID+":processing", ingest.EventProcessing, j.OwnerID, res.JobID, "", statusData("processing", specURL(j)))
		return h.save(ctx, j, ev)

	case ingest.PhaseReady, ingest.PhaseLinked:
		j.TrackID = res.TrackID
		j.Result = readyResult(res)
		// A ready/linked may arrive while the job is still queued (a lost
		// processing heartbeat) — step it through running so the To(Done)
		// transition is legal.
		if j.State == job.StateQueued {
			_ = j.To(job.StateRunning)
		}
		if err := j.To(job.StateDone); err != nil {
			return fmt.Errorf("to done: %w", err)
		}
		ev := event(res.JobID+":ready", ingest.EventReady, j.OwnerID, res.TrackID, res.TrackID, j.Result)
		return h.save(ctx, j, ev)

	case ingest.PhaseFailed:
		// Retry policy lives HERE: a retriable failure below the cap
		// re-dispatches a fresh ingest.work (job stays non-terminal).
		if res.Retriable && j.Attempts < h.d.MaxAttempts {
			j.Attempts++
			req := specRequest(j)
			return h.d.Repo.WithTx(ctx, func(tx ports.Tx) error {
				if err := h.d.Repo.SaveTx(ctx, tx, j); err != nil {
					return err
				}
				return h.dispatchWork(ctx, tx, res.JobID, req.URL, req.Title, j.OwnerID, j.Attempts+1)
			})
		}
		if !j.State.IsTerminal() {
			if err := j.To(job.StateFailed); err != nil {
				return fmt.Errorf("to failed: %w", err)
			}
		}
		j.Err = res.Error
		ev := event(res.JobID+":failed", ingest.EventFailed, j.OwnerID, res.JobID, j.TrackID, failData(res.Error))
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
// WorkStream), reliably fanned out to the ingest worker by the same relay.
func (c *core) dispatchWork(ctx context.Context, tx ports.Tx, jobID, url, title, owner string, attempt int) error {
	b, err := ingest.WorkCommand{JobID: jobID, URL: url, Title: title, OwnerID: owner, Attempt: attempt}.Marshal()
	if err != nil {
		return err
	}
	return c.d.Events.Publish(ctx, tx, c.d.WorkStream, b)
}

// event builds a lifecycle event. Its ID is derived from the JOB id + type so
// redelivery (on either stream) re-emits the SAME id, keeping downstream
// projections idempotent.
func event(id, typ, userID, docID, trackID string, data []byte) ingest.TrackEvent {
	return ingest.TrackEvent{
		ID:      id,
		Type:    typ,
		UserID:  userID,
		DocID:   docID,
		TrackID: trackID,
		Data:    data,
	}
}

// --- spec / payload helpers ---

// specRequest recovers the original ingest.request from the job's Spec (used to
// recover the URL/title when re-dispatching a retry).
func specRequest(j *job.Job) ingest.Request {
	req, _ := ingest.DecodeRequest(j.Spec)
	return req
}

// specURL is specRequest's URL — the source url carried through the lifecycle.
func specURL(j *job.Job) string { return specRequest(j).URL }
