// Package library is the server-authored write path for the Personal Library:
// it projects ingest lifecycle events and publish flips into a user's
// library_items documents, which clients receive purely by pulling.
package library

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/profile/internal/domain/changes"
	"github.com/jiva-studio/shruti/profile/internal/domain/hlc"
	"github.com/jiva-studio/shruti/profile/internal/ports"
)

// UseCase writes server-authored library_items changes.
type UseCase struct {
	tx    ports.Transactor
	clock *hlc.Clock
}

// New builds the library use case.
func New(tx ports.Transactor) (*UseCase, error) {
	if tx == nil {
		return nil, errors.New("library: nil transactor")
	}
	return &UseCase{tx: tx, clock: hlc.NewClock()}, nil
}

// ApplyLibraryLifecycle projects one lifecycle event (queued/processing/
// ready/failed → upsert, removed → delete) under a rank-ordered hlc, so a
// later state wins regardless of broker arrival order (see hlc.Clock.Ranked).
// All states of one ingest share the membership doc_id, so the row advances in
// place. generation lifts a re-run of a dead-lettered job above the prior
// run's terminal stamp; it is 0 for the original run.
func (u *UseCase) ApplyLibraryLifecycle(ctx context.Context, userID uuid.UUID, docID, op string, generation, rank int, data json.RawMessage) (changes.Change, error) {
	if op != changes.OpUpsert && op != changes.OpDelete {
		return changes.Change{}, changes.BadRequest("invalid op %q (want upsert|delete)", op)
	}
	if docID == "" {
		return changes.Change{}, changes.BadRequest("doc_id is required")
	}
	if op == changes.OpUpsert && len(data) == 0 {
		return changes.Change{}, changes.BadRequest("data is required for an upsert")
	}
	c := changes.Change{
		Collection: changes.LibraryItems,
		DocID:      docID,
		Op:         op,
		Data:       data,
		HLC:        u.clock.Ranked(generation, rank),
	}
	err := u.tx.WithinTx(ctx, func(tx ports.Tx) error {
		if err := tx.LockUser(ctx, userID); err != nil {
			return err
		}
		return applyServerChange(ctx, tx, userID, c)
	})
	if err != nil {
		return changes.Change{}, err
	}
	return c, nil
}

// MarkPublished records that a library track has been promoted into the
// published corpus (origin='published').
//
// library_items is keyed by the membership id, while a promotion carries only
// the content hash, so the track is mapped back to its membership rows and
// each is flipped. The flip merges origin into the master's data rather than
// overwriting it, so the ready-time metadata survives the replace-all upsert.
// It is stamped with the Terminal hlc, so it wins over every lifecycle state,
// and a redelivered promotion finds the flip already master and writes
// nothing. The lookup, the master read and the write share one transaction
// under the user's lock. See unflippable for a track with no membership.
func (u *UseCase) MarkPublished(ctx context.Context, userID uuid.UUID, trackID string) error {
	if trackID == "" {
		return changes.BadRequest("track_id is required")
	}
	terminal := u.clock.Terminal()
	return u.tx.WithinTx(ctx, func(tx ports.Tx) error {
		if err := tx.LockUser(ctx, userID); err != nil {
			return err
		}
		docIDs, err := tx.LibraryMembershipsByTrack(ctx, userID, trackID)
		if err != nil {
			return err
		}
		if len(docIDs) == 0 {
			return unflippable(ctx, tx, userID, trackID)
		}
		for _, docID := range docIDs {
			master, found, err := tx.Latest(ctx, userID, changes.LibraryItems, docID)
			if err != nil {
				return err
			}
			var base json.RawMessage
			if found {
				base = master.Data
			}
			merged, err := changes.PublishedData(base, trackID)
			if err != nil {
				return err
			}
			c := changes.Change{Collection: changes.LibraryItems, DocID: docID, Op: changes.OpUpsert, Data: merged, HLC: terminal}
			if err := applyServerChange(ctx, tx, userID, c); err != nil {
				return err
			}
		}
		return nil
	})
}

// unflippable answers a promotion whose track has no membership. A track the
// log once carried was removed by the user, so the flip is dropped (nil); one
// it never carried has not projected yet, and changes.ErrNotProjected asks the
// caller to retry later.
func unflippable(ctx context.Context, tx ports.Tx, userID uuid.UUID, trackID string) error {
	projected, err := tx.LibraryTrackProjected(ctx, userID, trackID)
	if err != nil {
		return err
	}
	if projected {
		return nil
	}
	return changes.ErrNotProjected
}

// applyServerChange writes one server-authored change only when its hlc is
// above the document's current master. Installed clients apply pulled
// library_items rows in global_seq order and take each one wholesale, so
// every appended row must be the newest state: an event at or below the
// master (a redelivery, or a lower state arriving late) leaves both the change
// log and the projection untouched.
func applyServerChange(ctx context.Context, tx ports.Tx, userID uuid.UUID, c changes.Change) error {
	master, found, err := tx.Latest(ctx, userID, c.Collection, c.DocID)
	if err != nil {
		return err
	}
	if found && c.HLC <= master.HLC {
		return nil
	}
	if err := tx.Append(ctx, userID, hlc.ServerNodeID, c); err != nil {
		return err
	}
	return tx.ApplyState(ctx, userID, c)
}
