// Package ports declares what profile's use cases ask of the outside world:
// the change log and its typed state projection, device cursors, and the
// transaction every write runs in.
package ports

import (
	"context"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/profile/internal/domain/changes"
)

// Transactor is the unit of work: fn runs in one transaction that commits
// when fn returns nil and rolls back otherwise.
type Transactor interface {
	WithinTx(ctx context.Context, fn func(Tx) error) error
}

// Tx is the change log and state projection as seen from inside one
// transaction.
type Tx interface {
	// LockUser serializes one user's writes until the transaction ends, so
	// global_seq is assigned in commit order.
	LockUser(ctx context.Context, userID uuid.UUID) error
	// Latest returns a document's master, or found=false when it was never
	// written. A server-owned collection's master is its highest-hlc row; a
	// client-owned one's is its newest row by global_seq.
	Latest(ctx context.Context, userID uuid.UUID, collection, docID string) (master changes.Change, found bool, err error)
	// Append adds a change-log row written by deviceID. A row with the same
	// (collection, doc_id, hlc) is already there and is left alone.
	Append(ctx context.Context, userID uuid.UUID, deviceID string, c changes.Change) error
	// ApplyState projects c onto its collection's typed state table.
	ApplyState(ctx context.Context, userID uuid.UUID, c changes.Change) error
	// LibraryMembershipsByTrack returns the library_items doc_ids whose
	// projection carries trackID.
	LibraryMembershipsByTrack(ctx context.Context, userID uuid.UUID, trackID string) ([]string, error)
	// DocChanges returns every change-log row of one document by global_seq.
	DocChanges(ctx context.Context, key changes.DocKey) ([]changes.Change, error)
	// PurgeUser deletes every row the user has in every profile table.
	PurgeUser(ctx context.Context, userID uuid.UUID) error
}

// ChangeFeed reads a user's change log outside any transaction.
type ChangeFeed interface {
	// Since returns up to limit rows with global_seq > cursor, in global_seq
	// order, including the caller's own device's writes.
	Since(ctx context.Context, userID uuid.UUID, cursor int64, limit int) ([]changes.Change, error)
}

// Cursors records how far each device has applied the change log.
type Cursors interface {
	// Ack raises the device's acked_seq to ackedSeq; it never moves back.
	Ack(ctx context.Context, userID uuid.UUID, deviceID string, ackedSeq int64) error
}
