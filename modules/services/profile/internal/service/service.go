// Package service holds profile's sync logic: apply changes with
// optimistic-concurrency (base_hlc) under a per-user advisory lock, pull
// changes since a cursor, acknowledge cursors, and purge a user.
//
// It is a thin generic sync substrate — no business rules about the content
// of the data; all merge logic runs on the client. The server only detects a
// stale base and rejects it back as a conflict.
package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti/profile/internal/hlc"
	"github.com/jiva-studio/shruti/profile/internal/store"
	"github.com/jiva-studio/shruti/profile/internal/wire"
)

// ValidationError is a caller-fault (400) — a malformed request body the
// client must fix, distinct from a transient server error.
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

func badRequest(format string, args ...any) error {
	return &ValidationError{Msg: fmt.Sprintf(format, args...)}
}

// IsValidation reports whether err is a client-fault validation error.
func IsValidation(err error) bool {
	var v *ValidationError
	return errors.As(err, &v)
}

// ForbiddenError is a caller-fault (403) — the client attempted an operation it
// is not permitted to perform, e.g. pushing a server-owned collection. Code is
// a stable machine-readable slug the edge surfaces to the client.
type ForbiddenError struct {
	Code string
	Msg  string
}

func (e *ForbiddenError) Error() string { return e.Msg }

func forbidden(code, format string, args ...any) error {
	return &ForbiddenError{Code: code, Msg: fmt.Sprintf(format, args...)}
}

// AsForbidden reports whether err is a client-fault forbidden error, returning
// it so the caller can read its stable Code.
func AsForbidden(err error) (*ForbiddenError, bool) {
	var f *ForbiddenError
	ok := errors.As(err, &f)
	return f, ok
}

// Service wires the store repos. Own pool — profile knows only its own DB.
type Service struct {
	Pool         *pgxpool.Pool
	Changes      *store.ChangesRepo
	Cursors      *store.CursorRepo
	Maint        *store.MaintenanceRepo
	PullMaxLimit int
	// HLC mints server-authored change stamps. Optional — a lazy default is
	// created on first use so hand-built Services stay valid; production wires
	// one explicitly.
	HLC *hlc.Clock
}

// clock returns the configured server HLC generator, lazily creating a default
// so ApplyServerChange works on a Service constructed without one.
func (s *Service) clock() *hlc.Clock {
	if s.HLC == nil {
		s.HLC = hlc.NewClock()
	}
	return s.HLC
}

// Push applies a batch of local changes for one user. Each row is applied if
// its base_hlc matches the current master (or the doc is new); otherwise it
// is returned under Conflicts with the master row to re-merge. The whole
// batch commits in one transaction under the per-user advisory lock, so
// global_seq is assigned in commit order.
func (s *Service) Push(ctx context.Context, userID uuid.UUID, req wire.PushRequest) (wire.PushResponse, error) {
	resp := wire.PushResponse{Applied: []wire.Ref{}, Conflicts: []wire.Conflict{}}
	if req.DeviceID == "" {
		return resp, badRequest("device_id is required")
	}
	// Validate the whole batch up-front so a bad row fails fast without a
	// half-applied transaction.
	for _, it := range req.Changes {
		if !store.Collections[it.Collection] {
			return resp, badRequest("unknown collection %q", it.Collection)
		}
		if store.ServerOwned[it.Collection] {
			// Pull-only: server-owned collections are authored solely by the
			// server (ApplyServerChange). Rejecting the push here — before any
			// DB work — stops a client forging or overwriting server state.
			return resp, forbidden("server_owned_collection",
				"collection %q is server-owned and cannot be pushed", it.Collection)
		}
		if it.Op != "upsert" && it.Op != "delete" {
			return resp, badRequest("invalid op %q (want upsert|delete)", it.Op)
		}
		if it.DocID == "" {
			return resp, badRequest("doc_id is required")
		}
		if it.HLC == "" {
			return resp, badRequest("hlc is required")
		}
	}

	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return resp, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := store.AdvisoryXactLock(ctx, tx, userID); err != nil {
		return resp, err
	}

	for _, it := range req.Changes {
		master, found, err := s.Changes.Latest(ctx, tx, userID, it.Collection, it.DocID)
		if err != nil {
			return wire.PushResponse{}, err
		}

		switch {
		case found && master.HLC == it.HLC:
			// Exact retry — already applied. Idempotent no-op.
			resp.Applied = append(resp.Applied, wire.Ref{Collection: it.Collection, DocID: it.DocID})
			continue
		case found && it.BaseHLC != master.HLC:
			// Stale base — the client is behind. Hand back the master to merge.
			resp.Conflicts = append(resp.Conflicts, wire.Conflict{
				Collection: it.Collection,
				DocID:      it.DocID,
				Master:     masterToChange(it.Collection, it.DocID, master),
			})
			continue
		}
		// Apply: new doc, or base matches the current master (fast-forward).
		if err := s.Changes.Append(ctx, tx, userID, req.DeviceID, it); err != nil {
			return wire.PushResponse{}, err
		}
		if err := store.ApplyState(ctx, tx, userID, it); err != nil {
			return wire.PushResponse{}, err
		}
		resp.Applied = append(resp.Applied, wire.Ref{Collection: it.Collection, DocID: it.DocID})
	}

	if err := tx.Commit(ctx); err != nil {
		return wire.PushResponse{}, err
	}
	return resp, nil
}

// ApplyServerChange is the server-authored write path — the net-new counterpart
// to the client Push. It writes ONE change for a server-owned collection (today
// only library_items) as the single writer "server:orchestrator", so clients
// receive it purely by pulling; they never push these documents.
//
// eventID is the source event's idempotency key (the broker message id). The
// server HLC is DETERMINISTIC in that key, so a redelivered event maps to the
// SAME hlc and is absorbed by UNIQUE(user_id, collection, doc_id, hlc) — a
// redelivery leaves exactly one change-log row, not a duplicate. Because a
// server-owned collection has a single writer whose events arrive in broker
// order, ordering by that (monotonic) key is the correct total order; the
// projection is (re)written only when this event is the newest write for the
// doc, so a redelivered OLDER event cannot clobber a newer state.
//
// It mirrors Push's durability guarantees for a single row: one transaction
// under the per-user advisory lock (so global_seq is assigned in commit order),
// appends the change-log row (device_id "server:orchestrator") and projects it.
func (s *Service) ApplyServerChange(ctx context.Context, userID uuid.UUID, collection, docID, op, eventID string, data json.RawMessage) (wire.Change, error) {
	if !store.Collections[collection] {
		return wire.Change{}, badRequest("unknown collection %q", collection)
	}
	if !store.ServerOwned[collection] {
		return wire.Change{}, badRequest("collection %q is not server-owned", collection)
	}
	if op != "upsert" && op != "delete" {
		return wire.Change{}, badRequest("invalid op %q (want upsert|delete)", op)
	}
	if docID == "" {
		return wire.Change{}, badRequest("doc_id is required")
	}
	if eventID == "" {
		return wire.Change{}, badRequest("event_id is required")
	}
	if op == "upsert" && len(data) == 0 {
		return wire.Change{}, badRequest("data is required for an upsert")
	}

	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return wire.Change{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := store.AdvisoryXactLock(ctx, tx, userID); err != nil {
		return wire.Change{}, err
	}

	it := wire.PushItem{
		Collection: collection,
		DocID:      docID,
		Op:         op,
		Data:       data,
		HLC:        s.clock().Deterministic(eventID),
	}

	// Read the current master to apply last-writer-wins by hlc, mirroring the
	// client: append the (idempotent) change-log row, but only (re)project when
	// this event is the newest write for the doc.
	master, found, err := s.Changes.Latest(ctx, tx, userID, collection, docID)
	if err != nil {
		return wire.Change{}, err
	}

	// Append is a no-op via ON CONFLICT DO NOTHING when this exact hlc already
	// exists — the redelivery collision that keeps the log at one row.
	if err := s.Changes.Append(ctx, tx, userID, hlc.ServerNodeID, it); err != nil {
		return wire.Change{}, err
	}
	if !found || it.HLC > master.HLC {
		if err := store.ApplyState(ctx, tx, userID, it); err != nil {
			return wire.Change{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return wire.Change{}, err
	}
	return wire.Change{
		Collection: collection,
		DocID:      docID,
		Op:         op,
		Data:       data,
		HLC:        it.HLC,
	}, nil
}

// MarkPublished is the server-authored flip that records a library track has
// been promoted into the published corpus (origin='published'). It is driven by
// the publish-service's `track.published` event.
//
// In the server-authored ingest path a library_items row is keyed by
// doc_id == track_id (the orchestrator's track.ready sets doc_id to the content
// hash), so the flip targets doc_id = trackID. It MERGES origin into the
// existing projection's data rather than overwriting, so the ready-time metadata
// (title/lang/audio_key/…) is preserved. Idempotent: the event id
// "<track_id>:published" yields a deterministic hlc, so a redelivery collapses
// to one change-log row.
func (s *Service) MarkPublished(ctx context.Context, userID uuid.UUID, trackID, eventID string) error {
	if trackID == "" {
		return badRequest("track_id is required")
	}
	if eventID == "" {
		return badRequest("event_id is required")
	}
	// Read the current server-authored projection so origin is merged in, not
	// clobbering the ready-time metadata.
	master, found, err := s.Changes.Latest(ctx, s.Pool, userID, "library_items", trackID)
	if err != nil {
		return err
	}
	data := map[string]json.RawMessage{}
	if found && len(master.Data) > 0 {
		if err := json.Unmarshal(master.Data, &data); err != nil {
			return fmt.Errorf("decode master data: %w", err)
		}
	}
	data["origin"] = json.RawMessage(`"published"`)
	if _, ok := data["track_id"]; !ok {
		tid, _ := json.Marshal(trackID)
		data["track_id"] = tid
	}
	merged, err := json.Marshal(data)
	if err != nil {
		return err
	}
	_, err = s.ApplyServerChange(ctx, userID, "library_items", trackID, "upsert", eventID, merged)
	return err
}

// Pull returns changes for the user with global_seq > cursor, excluding the
// caller's own device (echo suppression), paginated. limit is clamped to the
// hard maximum so a client cannot demand an unbounded page.
func (s *Service) Pull(ctx context.Context, userID uuid.UUID, req wire.PullRequest) (wire.PullResponse, error) {
	limit := req.Limit
	if limit <= 0 || limit > s.PullMaxLimit {
		limit = s.PullMaxLimit
	}
	changes, err := s.Changes.Pull(ctx, userID, req.Cursor, limit)
	if err != nil {
		return wire.PullResponse{}, err
	}
	cursor := req.Cursor
	if n := len(changes); n > 0 {
		cursor = changes[n-1].ServerSeq
	}
	return wire.PullResponse{
		Changes: changes,
		Cursor:  cursor,
		HasMore: len(changes) == limit,
	}, nil
}

// AckCursor records the highest global_seq a device has applied.
func (s *Service) AckCursor(ctx context.Context, userID uuid.UUID, req wire.CursorRequest) error {
	if req.DeviceID == "" {
		return badRequest("device_id is required")
	}
	return s.Cursors.Ack(ctx, userID, req.DeviceID, req.AckedSeq)
}

// Purge erases every row for a user across all profile tables.
func (s *Service) Purge(ctx context.Context, userID uuid.UUID) error {
	return s.Maint.PurgeUser(ctx, userID)
}

func masterToChange(collection, docID string, m store.MasterChange) wire.Change {
	return wire.Change{
		ServerSeq:  m.ServerSeq,
		Collection: collection,
		DocID:      docID,
		Op:         m.Op,
		Data:       m.Data,
		HLC:        m.HLC,
	}
}
