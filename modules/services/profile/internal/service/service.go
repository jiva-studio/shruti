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
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/lectorium/profile/internal/store"
	"github.com/jiva-studio/lectorium/profile/internal/wire"
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

// Service wires the store repos. Own pool — profile knows only its own DB.
type Service struct {
	Pool         *pgxpool.Pool
	Changes      *store.ChangesRepo
	Cursors      *store.CursorRepo
	Maint        *store.MaintenanceRepo
	PullMaxLimit int
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

// Pull returns changes for the user with global_seq > cursor, excluding the
// caller's own device (echo suppression), paginated. limit is clamped to the
// hard maximum so a client cannot demand an unbounded page.
func (s *Service) Pull(ctx context.Context, userID uuid.UUID, excludeDevice string, req wire.PullRequest) (wire.PullResponse, error) {
	limit := req.Limit
	if limit <= 0 || limit > s.PullMaxLimit {
		limit = s.PullMaxLimit
	}
	changes, err := s.Changes.Pull(ctx, userID, req.Cursor, excludeDevice, limit)
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
