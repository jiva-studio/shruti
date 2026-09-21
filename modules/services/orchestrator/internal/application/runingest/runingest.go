// Package runingest is the orchestrator's coordination core. The orchestrator
// is a THIN coordinator: it does NOT fetch, transcribe, or store anything —
// that is the stateless `ingest` worker's job. This package holds the two
// entry handlers that make up the seam:
//
//   - RequestHandler.Submit is the synchronous HTTP entry (POST /orchestrator/
//     ingest): it verifies the PRO tier, keys the job on the verified subject,
//     and — in ONE transaction — commits the job, a `track.queued` outbox event,
//     and an `ingest.work` command that dispatches the heavy lifting to the
//     worker. A re-submit of a dead-lettered job restarts it in place.
//   - ResultHandler consumes `ingest.result` (ingest → orchestrator): it maps
//     the worker's phase reports (processing / ready / failed) onto job state
//     transitions and the `track.events` lifecycle, records the granular stage
//     for the status API, and owns the RETRY policy — a retriable failure below
//     the attempt cap re-dispatches; otherwise the job dead-letters.
//
// Guarantees:
//   - The job is the source of truth. Its id is derived deterministically
//     (UUIDv5) from the VERIFIED (user, source), so a re-submit maps to the SAME
//     job (idempotent create + dedup).
//   - `track.events` ids are derived from the JOB id, so queued/processing/
//     ready/failed for one job are stable across redelivery — downstream
//     projections stay idempotent.
//   - Everything is driven through ports, so the whole seam is exercised with
//     fakes (no Postgres, no broker).
package runingest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/orchestrator/internal/domain/ingest"
	"github.com/jiva-studio/shruti/orchestrator/internal/domain/job"
	"github.com/jiva-studio/shruti/orchestrator/internal/ports"
)

// jobNamespace seeds the deterministic (UUIDv5) job id. Keying it on
// (user, source) makes a re-add of the same lecture map to the SAME job, so
// the existing-job check dedups it — no duplicate membership, no reprocess.
var jobNamespace = uuid.MustParse("1b671a64-40d5-491e-99b0-da01ff1f3341")

// ytIDRe pulls the 11-char YouTube video id out of any watch / shorts / live /
// youtu.be URL so URL variants of one video share a dedup key. Case-insensitive
// to match the client's `hasSource` check (useLibraryStore YT_ID has /i), so a
// mixed-case host can't make the two disagree on whether a video is already
// added.
var ytIDRe = regexp.MustCompile(`(?i)(?:youtube\.com/(?:watch\?[^\s]*\bv=|shorts/|live/)|youtu\.be/)([\w-]{11})`)

// sourceKey normalizes a source URL to a stable dedup key: the YouTube video id
// when present (so watch?v= / youtu.be / extra params collapse to one), else
// the trimmed URL.
func sourceKey(rawURL string) string {
	if m := ytIDRe.FindStringSubmatch(rawURL); m != nil {
		return "yt:" + m[1]
	}
	return strings.TrimSpace(rawURL)
}

// jobIDFor derives the job id: per (user, source) when the user is known —
// dedup across re-adds — else per broker message (redelivery-idempotent only).
func jobIDFor(userID, msgID, url string) string {
	seed := msgID
	if strings.TrimSpace(userID) != "" {
		seed = userID + "\x00" + sourceKey(url)
	}
	return uuid.NewSHA1(jobNamespace, []byte(seed)).String()
}

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

// RequestHandler is the ingest submission entry — its Submit method backs
// POST /orchestrator/ingest.
type RequestHandler struct{ core }

// NewRequestHandler builds the request handler, defaulting the attempt cap and
// stream names.
func NewRequestHandler(d Deps) *RequestHandler {
	d.applyDefaults()
	return &RequestHandler{core{d}}
}

// createJob commits a brand-new job together with its track.queued event and
// the first ingest.work dispatch in ONE transaction (the transactional-outbox
// invariant), so the worker is invoked iff the job was durably created. spec is
// the stored ingest.Request payload (recovered by specRequest on a later retry).
func (h *RequestHandler) createJob(ctx context.Context, runID, owner string, req ingest.Request, spec []byte) error {
	j := &job.Job{
		ID:           runID,
		Kind:         job.KindLibraryIngest,
		Op:           req.Op,
		MembershipID: req.MembershipID,
		OwnerID:      owner,
		State:        job.StateQueued,
		Spec:         spec,
	}
	return h.d.Repo.WithTx(ctx, func(tx ports.Tx) error {
		if err := h.d.Repo.CreateTx(ctx, tx, j); err != nil {
			return err
		}
		// Ingest drives the library row's lifecycle (the queued spinner). Translate
		// runs against an ALREADY-ready track, so it must not reset that row's
		// status — its only library effect is the merged variant on completion.
		// Its progress is polled on the run itself instead.
		if req.Op == job.OpIngest {
			queued := event(runID+":queued", ingest.EventQueued, req.RequestID, owner, req.MembershipID, "", j.Generation, statusData("queued", req.Title, req.URL))
			if err := h.publishEvent(ctx, tx, queued); err != nil {
				return err
			}
		}
		return h.dispatchWork(ctx, tx, runID, owner, req, 1)
	})
}

// runIdentity derives the run id and the membership it advances. Ingest keys the
// run per (user, source) — a re-add maps to the same run — and the membership IS
// that run (one per track). Translate is a separate run per (membership, target
// language) that advances the SAME membership the ingest created.
func runIdentity(userID string, req ingest.Request) (runID, membershipID string) {
	if req.Op == job.OpTranslate {
		seed := userID + "\x00translate\x00" + req.MembershipID + "\x00" + req.TargetLang
		return uuid.NewSHA1(jobNamespace, []byte(seed)).String(), req.MembershipID
	}
	id := jobIDFor(userID, "", req.URL)
	return id, id
}

// SubmitResult is the outcome of an API-driven ingest submission: the
// deterministic job id — which is also the library membership id the client
// keys its library row on and polls for status — and the job's current state.
type SubmitResult struct {
	JobID        string
	MembershipID string
	State        job.State
}

// ErrNotPro rejects an API ingest submission whose token does not grant an
// active pro tier. Unlike the stream path (failNotPro) the API creates NOTHING
// on a bad token — it is a plain 4xx the client renders, not a dead-lettered job.
var ErrNotPro = errors.New("pro tier not verified")

// ErrMembershipNotFound rejects a translate run whose target membership does not
// exist or is not owned by the caller — returned as a 404 so it never reveals
// that another user's track exists.
var ErrMembershipNotFound = errors.New("membership not found")

// Submit is the synchronous API entry for an ingest request (POST /ingest). It
// verifies the token and keys the job on the VERIFIED subject — so a
// client-supplied user_id can neither misattribute the job nor split the dedup
// (the anon-dedup fix) — then creates / dedups / restarts and returns the job id
// and current state for the client to poll. A dead-lettered job restarts in
// place (the same retry path the stream uses); an in-flight or done job is
// returned as-is.
func (h *RequestHandler) Submit(ctx context.Context, req ingest.Request) (SubmitResult, error) {
	userID, pro, err := h.d.Tier.VerifyPro(req.Token)
	if err != nil || !pro {
		return SubmitResult{}, ErrNotPro
	}
	req.UserID = userID // authoritative subject — never trust the client-supplied id
	runID, membership := runIdentity(userID, req)
	if req.Op == "" {
		req.Op = job.OpIngest
	}
	req.MembershipID = membership // carried into the spec so a retry re-dispatches it
	lg := slog.With("run_id", runID, "op", req.Op, "request_id", req.RequestID)

	// A translate run advances an EXISTING track membership — verify it exists and
	// belongs to THIS user before touching it, so a client can't translate (and
	// read the variants of) someone else's track. The membership id is the
	// original ingest run id, so a plain job load resolves the owner.
	if req.Op == job.OpTranslate {
		owner, oerr := h.d.Repo.Get(ctx, membership)
		if oerr != nil {
			return SubmitResult{}, fmt.Errorf("load membership: %w", oerr)
		}
		if owner == nil || owner.OwnerID != userID {
			return SubmitResult{}, ErrMembershipNotFound
		}
	}

	existing, err := h.d.Repo.Get(ctx, runID)
	if err != nil {
		return SubmitResult{}, fmt.Errorf("load job: %w", err)
	}
	if existing != nil {
		if existing.State == job.StateFailed {
			if err := h.restartFailed(ctx, existing, req); err != nil {
				return SubmitResult{}, err
			}
			return SubmitResult{JobID: runID, MembershipID: membership, State: job.StateQueued}, nil
		}
		lg.InfoContext(ctx, "submit_duplicate", "state", string(existing.State))
		return SubmitResult{JobID: runID, MembershipID: membership, State: existing.State}, nil
	}

	spec, err := json.Marshal(req)
	if err != nil {
		return SubmitResult{}, fmt.Errorf("marshal spec: %w", err)
	}
	lg.InfoContext(ctx, "job_created", "user_id", userID, "url", req.URL)
	if err := h.createJob(ctx, runID, userID, req, spec); err != nil {
		// Lost the create race with a concurrent submit of the SAME run (a
		// double-tap, the same URL from a second device). The winner created it, so
		// this is the dedup path above, not a failure to report to the user.
		if errors.Is(err, ports.ErrJobExists) {
			return h.dedup(ctx, runID, membership, lg)
		}
		return SubmitResult{}, err
	}
	return SubmitResult{JobID: runID, MembershipID: membership, State: job.StateQueued}, nil
}

// dedup resolves a lost create race by re-reading the winning run, so the
// duplicate submission returns the same result the Get-hit path would have.
func (h *RequestHandler) dedup(ctx context.Context, runID, membership string, lg *slog.Logger) (SubmitResult, error) {
	existing, err := h.d.Repo.Get(ctx, runID)
	if err != nil {
		return SubmitResult{}, fmt.Errorf("load job: %w", err)
	}
	state := job.StateQueued
	if existing != nil {
		state = existing.State
	}
	lg.InfoContext(ctx, "submit_duplicate", "state", string(state), "raced", true)
	return SubmitResult{JobID: runID, MembershipID: membership, State: state}, nil
}

// StatusLabel maps the internal job state onto the client-facing lifecycle
// vocabulary the library card and the synced library_items.status use, so the
// live poll and the eventual sync agree on the word.
func StatusLabel(s job.State) string {
	switch s {
	case job.StateQueued:
		return "queued"
	case job.StateRunning:
		return "processing"
	case job.StateDone:
		return "ready"
	case job.StateFailed:
		return "failed"
	case job.StateCancelled:
		return "cancelled"
	default:
		return string(s)
	}
}

// JobStatus is the live status the API serves for GET /ingest/{id}. State uses
// the client lifecycle vocabulary; ErrorCode is the STABLE failure code (never
// the raw internal error); TrackID is set once the content hash is known.
type JobStatus struct {
	State     string `json:"state"`
	Attempts  int    `json:"attempts"`
	ErrorCode string `json:"error,omitempty"`
	TrackID   string `json:"track_id,omitempty"`
	// Stage is the granular pipeline step (downloading / transcribing / …), set
	// only while running. Poll-only — the client shows it live, never persists it.
	Stage string `json:"stage,omitempty"`
	// Percent is the download completion (0-100), set only while the downloading
	// stage is running. Poll-only, alongside Stage.
	Percent int `json:"percent,omitempty"`
}

// StatusOf projects a job aggregate into the API status DTO, mapping the raw
// failure text to a stable client code so no internal detail leaks to the device.
func StatusOf(j *job.Job) JobStatus {
	s := JobStatus{
		State:    StatusLabel(j.State),
		Attempts: j.Attempts,
		TrackID:  j.TrackID,
	}
	if j.State == job.StateFailed && j.Err != "" {
		s.ErrorCode = failCode(j.Err)
	}
	// The pipeline stage is meaningful only while running; decode the poll-only
	// progress blob the worker's heartbeats recorded.
	if j.State == job.StateRunning && len(j.Progress) > 0 {
		var p struct {
			Stage   string `json:"stage"`
			Percent int    `json:"percent"`
		}
		if json.Unmarshal(j.Progress, &p) == nil {
			s.Stage = p.Stage
			s.Percent = p.Percent
		}
	}
	return s
}

// restartFailed re-runs a DEAD-LETTERED job on a user-initiated retry (a re-add
// of a source whose job already dead-lettered). It re-verifies PRO from the
// fresh request token — the tier may have lapsed since the job first failed, and
// a failed job is terminal so this is not the in-flight case failNotPro guards
// against — then bumps the generation so the re-run's lifecycle stamps sort above
// the prior run's terminal state, and dispatches a fresh ingest.work in one tx
// with the track.queued event.
//
// Attempts stay MONOTONIC across the restart (never reset), so the in-flight
// attempt number is unique across every generation and a stale result from the
// prior run is discarded by ResultHandler's attempt filter alone — no generation
// needs to round-trip through the worker. The restart is re-checked under a row
// lock so two racing retries (a double-tap, a redelivery) restart exactly once;
// the loser sees a non-failed state and no-ops.
func (h *RequestHandler) restartFailed(ctx context.Context, j *job.Job, req ingest.Request) error {
	lg := slog.With("job_id", j.ID, "request_id", req.RequestID)
	_, pro, verr := h.d.Tier.VerifyPro(req.Token)
	if verr != nil {
		lg.WarnContext(ctx, "retry_token_unverified", "user_id", req.UserID, "err", verr.Error())
		pro = false // an unverifiable token is not an entitlement
	}
	if !pro {
		lg.WarnContext(ctx, "retry_rejected_not_pro", "user_id", req.UserID)
		return nil // leave the job dead-lettered, ack
	}
	return h.d.Repo.WithTx(ctx, func(tx ports.Tx) error {
		locked, err := h.d.Repo.GetForUpdateTx(ctx, tx, j.ID)
		if err != nil {
			return err
		}
		if locked == nil || locked.State != job.StateFailed {
			lg.InfoContext(ctx, "retry_superseded", "state", stateOf(locked))
			return nil // another retry already restarted it, or it is gone
		}
		if err := locked.To(job.StateQueued); err != nil {
			return fmt.Errorf("restart to queued: %w", err)
		}
		locked.Generation++
		locked.Err = ""
		// Re-dispatch from the ORIGINAL validated spec (same source — the
		// deterministic job id guarantees it), carrying the retry's correlation id
		// so the re-run's logs and events join the turn that triggered it.
		disp := specRequest(locked)
		disp.RequestID = req.RequestID
		attempt := locked.Attempts + 1
		lg.InfoContext(ctx, "job_restarted", "generation", locked.Generation, "attempt", attempt, "owner", locked.OwnerID)
		if err := h.d.Repo.SaveTx(ctx, tx, locked); err != nil {
			return err
		}
		// Same guard as createJob: only ingest drives the library row's lifecycle,
		// and the row is keyed on the MEMBERSHIP — a translate run's id is not a
		// library row id, so emitting it would insert a phantom card.
		if locked.Op == job.OpIngest {
			queued := event(locked.ID+":queued", ingest.EventQueued, disp.RequestID, locked.OwnerID, locked.MembershipID, "", locked.Generation, statusData("queued", disp.Title, disp.URL))
			if err := h.publishEvent(ctx, tx, queued); err != nil {
				return err
			}
		}
		return h.dispatchWork(ctx, tx, locked.ID, locked.OwnerID, disp, attempt)
	})
}

// stateOf renders a possibly-nil job's state for a log field.
func stateOf(j *job.Job) string {
	if j == nil {
		return "gone"
	}
	return string(j.State)
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
		// Attempt-guard: discard a heartbeat from a SUPERSEDED attempt (a
		// re-dispatch owns the job now) so a straggler can't move state or
		// overwrite the live run's progress. Lenient when the result carries no
		// attempt (0) — legacy/attempt-less heartbeats stay best-effort.
		if res.Attempt != 0 && res.Attempt != j.Attempts+1 {
			return nil
		}
		// Record the granular pipeline stage for the live status poll. Best-effort
		// and off the hot path — a lost write only means a coarser spinner, and it
		// must not fail the ingest. Every heartbeat (not just the first) updates it.
		if res.Stage != "" {
			if err := h.d.Repo.UpdateProgress(ctx, res.JobID, progressData(res.Stage, res.Percent)); err != nil {
				lg.WarnContext(ctx, "progress_update_failed", "err", err.Error())
			}
		}
		if j.State != job.StateQueued {
			return nil // already running — the stage write above is the only effect
		}
		if err := j.To(job.StateRunning); err != nil {
			return fmt.Errorf("to running: %w", err)
		}
		if j.Op == job.OpTranslate {
			// Translate runs against an ALREADY-ready track: advance the run state
			// (for the status poll) but emit NO library lifecycle — that would reset
			// the row to a spinner. Its only library effect is the merged variant.
			return h.save(ctx, j)
		}
		ev := event(res.JobID+":processing", ingest.EventProcessing, res.RequestID, j.OwnerID, j.MembershipID, "", j.Generation, statusData("processing", specRequest(j).Title, specRequest(j).URL))
		return h.save(ctx, j, ev)

	case ingest.PhaseReady:
		// Read the ingest run's state BEFORE the membership: the ingest commits its
		// terminal state and the membership row in ONE tx, so observing it settled
		// first and finding no row after is proof the row can never arrive. The
		// reverse order would read "settled" from a tx that committed in between
		// and dead-letter a membership that now exists.
		ingestSettled := true
		if j.Op == job.OpTranslate {
			// The membership id IS the ingest run's id (runIdentity).
			ing, gerr := h.d.Repo.Get(ctx, j.MembershipID)
			if gerr != nil {
				return fmt.Errorf("load ingest run: %w", gerr)
			}
			ingestSettled = ing == nil || ing.State.IsTerminal()
		}
		// Merge into the track membership under a row lock and emit the merged doc
		// keyed on membership_id (the stable library row id). Ingest sets the full
		// doc at the run's generation; translate appends its variant and takes
		// version+1 so it out-ranks the prior ready under LWW.
		return h.d.Repo.WithTx(ctx, func(tx ports.Tx) error {
			m, err := h.d.Repo.GetMembershipForUpdateTx(ctx, tx, j.MembershipID)
			if err != nil {
				return err
			}
			// Translate advances an EXISTING row. Absent while its ingest is still in
			// flight means NOT YET — return an error so the entry stays pending and
			// redelivery heals it. Absent once that ingest has settled means gone: no
			// redelivery can conjure the row, so settle the run as failed and ack
			// rather than poisoning the stream forever.
			if j.Op == job.OpTranslate && m == nil {
				if !ingestSettled {
					return fmt.Errorf("translate ready ahead of ingest run %s: no membership yet", j.MembershipID)
				}
				lg.ErrorContext(ctx, "translate_membership_missing", "membership", j.MembershipID, "user_id", j.OwnerID)
				return h.failTx(ctx, tx, j, errMembershipMissing)
			}
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
			lg.InfoContext(ctx, "job_done", "op", j.Op, "track_id", res.TrackID, "membership", j.MembershipID)
			if err := h.d.Repo.SaveTx(ctx, tx, j); err != nil {
				return err
			}
			version, doc, err := mergeReady(j, res, m)
			if err != nil {
				return err
			}
			if err := h.d.Repo.SaveMembershipTx(ctx, tx, &job.Membership{ID: j.MembershipID, OwnerID: j.OwnerID, Version: version, Doc: doc}); err != nil {
				return err
			}
			ev := event(res.JobID+":ready", ingest.EventReady, res.RequestID, j.OwnerID, j.MembershipID, res.TrackID, version, doc)
			return h.publishEvent(ctx, tx, ev)
		})

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
			"op", j.Op, "error", res.Error, "attempts", j.Attempts,
			"exhausted", res.Retriable, "user_id", j.OwnerID)
		if j.Op == job.OpTranslate {
			// A translate failure must not fail the (already-ready) library row —
			// the user sees it only via the run status poll.
			return h.save(ctx, j)
		}
		ev := event(res.JobID+":failed", ingest.EventFailed, res.RequestID, j.OwnerID, j.MembershipID, j.TrackID, j.Generation, failData(res.Error, specRequest(j).Title, specRequest(j).URL))
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

// errMembershipMissing is the terminal error recorded when a run completes, the
// track membership it advances does not exist, and the ingest run that would
// have created it has already settled. Nothing will write the row now, so the
// run dead-letters and the result is acked instead of poisoning the stream.
const errMembershipMissing = "membership row missing"

// failTx settles a run as failed inside the caller's transaction. It emits no
// lifecycle event: the only caller is a translate run, whose failures the user
// sees through the run status poll (the library row is already ready).
func (c *core) failTx(ctx context.Context, tx ports.Tx, j *job.Job, reason string) error {
	if err := j.To(job.StateFailed); err != nil {
		return fmt.Errorf("to failed: %w", err)
	}
	j.Err = reason
	return c.d.Repo.SaveTx(ctx, tx, j)
}

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
		JobID:          jobID,
		RequestID:      req.RequestID,
		URL:            req.URL,
		Title:          req.Title,
		Author:         req.Author,
		OwnerID:        owner,
		Attempt:        attempt,
		TranslateLangs: req.TranslateLangs,
		Op:             req.Op,
		MembershipID:   req.MembershipID,
		Track:          req.Track,
		SourceLang:     req.SourceLang,
		TargetLang:     req.TargetLang,
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
// projections idempotent. generation is the job's re-run counter, carried so a
// retry's projection sorts above the prior run's terminal state.
func event(id, typ, requestID, userID, docID, trackID string, generation int, data []byte) ingest.TrackEvent {
	return ingest.TrackEvent{
		ID:         id,
		Type:       typ,
		RequestID:  requestID,
		UserID:     userID,
		DocID:      docID,
		Generation: generation,
		TrackID:    trackID,
		Data:       data,
	}
}

// --- spec / payload helpers ---

// specRequest recovers the original ingest.request from the job's Spec (used to
// recover the URL/title when re-dispatching a retry).
func specRequest(j *job.Job) ingest.Request {
	req, _ := ingest.DecodeRequest(j.Spec)
	return req
}
