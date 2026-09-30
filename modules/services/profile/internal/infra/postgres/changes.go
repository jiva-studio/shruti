package postgres

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti/profile/internal/domain/changes"
	"github.com/jiva-studio/shruti/profile/internal/ports"
)

// Store is the change log, cursors and state projection over one pool.
type Store struct {
	pool *pgxpool.Pool
}

// NewStore wraps a pool.
func NewStore(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

// WithinTx runs fn in one transaction, committing when fn returns nil.
func (s *Store) WithinTx(ctx context.Context, fn func(ports.Tx) error) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		return fn(&txStore{q: tx})
	})
}

// txStore is the change log and projection inside one transaction.
type txStore struct {
	q pgx.Tx
}

// LockUser takes pg_advisory_xact_lock(hashtext(user_id)), serializing one
// user's writes so global_seq is assigned in commit order. It is released at
// commit or rollback.
func (t *txStore) LockUser(ctx context.Context, userID uuid.UUID) error {
	_, err := t.q.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, userID.String())
	return err
}

// latestBySeqSQL picks a client-owned document's master: the last row pushed,
// since a push only appends when its base matches that row.
const latestBySeqSQL = `SELECT global_seq, op, data, hlc
   FROM profile.changes
  WHERE user_id = $1 AND collection = $2 AND doc_id = $3
  ORDER BY global_seq DESC
  LIMIT 1`

// latestByHLCSQL picks a server-owned document's master: the row with the
// highest hlc. Stamps are fixed-width, so byte order (COLLATE "C", the same
// order Go's string comparison uses) is clock order.
const latestByHLCSQL = `SELECT global_seq, op, data, hlc
   FROM profile.changes
  WHERE user_id = $1 AND collection = $2 AND doc_id = $3
  ORDER BY hlc COLLATE "C" DESC, global_seq DESC
  LIMIT 1`

func (t *txStore) Latest(ctx context.Context, userID uuid.UUID, collection, docID string) (changes.Change, bool, error) {
	query := latestBySeqSQL
	if changes.IsServerOwned(collection) {
		query = latestByHLCSQL
	}
	m := changes.Change{Collection: collection, DocID: docID}
	err := t.q.QueryRow(ctx, query, userID, collection, docID).
		Scan(&m.ServerSeq, &m.Op, &m.Data, &m.HLC)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return changes.Change{}, false, nil
		}
		return changes.Change{}, false, err
	}
	return m, true, nil
}

// Append inserts a change-log row. The UNIQUE (user_id, collection, doc_id,
// hlc) constraint makes a retried push a no-op (ON CONFLICT DO NOTHING).
func (t *txStore) Append(ctx context.Context, userID uuid.UUID, deviceID string, c changes.Change) error {
	var data any
	if c.Op == changes.OpDelete || len(c.Data) == 0 {
		data = nil
	} else {
		data = []byte(c.Data)
	}
	_, err := t.q.Exec(ctx,
		`INSERT INTO profile.changes (user_id, collection, doc_id, op, data, hlc, device_id)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 ON CONFLICT (user_id, collection, doc_id, hlc) DO NOTHING`,
		userID, c.Collection, c.DocID, c.Op, data, c.HLC, deviceID,
	)
	return err
}

func (t *txStore) ApplyState(ctx context.Context, userID uuid.UUID, c changes.Change) error {
	return applyState(ctx, t.q, userID, c)
}

func (t *txStore) LibraryMembershipsByTrack(ctx context.Context, userID uuid.UUID, trackID string) ([]string, error) {
	return libraryMembershipsByTrack(ctx, t.q, userID, trackID)
}

// Since returns changes for the user with global_seq > cursor, ordered by
// global_seq, up to limit rows. A device receives its OWN writes back too:
// re-applying them is idempotent (LWW on the same HLC is a no-op), and it is
// the only way a device that lost its local copy (reinstall/wipe) can recover
// its own data — echo-suppression here would make that loss permanent.
func (s *Store) Since(ctx context.Context, userID uuid.UUID, cursor int64, limit int) ([]changes.Change, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT global_seq, collection, doc_id, op, data, hlc
		   FROM profile.changes
		  WHERE user_id = $1
		    AND global_seq > $2
		  ORDER BY global_seq
		  LIMIT $3`,
		userID, cursor, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]changes.Change, 0, limit)
	for rows.Next() {
		var c changes.Change
		var data []byte
		if err := rows.Scan(&c.ServerSeq, &c.Collection, &c.DocID, &c.Op, &data, &c.HLC); err != nil {
			return nil, err
		}
		if len(data) > 0 {
			c.Data = json.RawMessage(data)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// Ack upserts the device's acked_seq. acked_seq only moves forward
// (GREATEST) so an out-of-order or replayed ack can't rewind compaction.
func (s *Store) Ack(ctx context.Context, userID uuid.UUID, deviceID string, ackedSeq int64) error {
	_, err := s.pool.Exec(ctx,
		`INSERT INTO profile.sync_cursors (user_id, device_id, acked_seq, updated_at)
		 VALUES ($1, $2, $3, now())
		 ON CONFLICT (user_id, device_id)
		 DO UPDATE SET acked_seq  = GREATEST(profile.sync_cursors.acked_seq, EXCLUDED.acked_seq),
		               updated_at = now()`,
		userID, deviceID, ackedSeq,
	)
	return err
}

// purgeTables lists every profile table a user has rows in. chat_messages is
// removed by the chat_sessions cascade, but it is listed explicitly so the
// purge is total and order-independent (idempotent either way).
var purgeTables = []string{
	"profile.chat_messages",
	"profile.chat_sessions",
	"profile.notes",
	"profile.listening_sessions",
	"profile.playlist_items",
	"profile.library_items",
	"profile.library_memberships",
	"profile.sync_cursors",
	"profile.changes",
}

// PurgeUser deletes every row for a user across all profile tables.
func (t *txStore) PurgeUser(ctx context.Context, userID uuid.UUID) error {
	for _, table := range purgeTables {
		if _, err := t.q.Exec(ctx, "DELETE FROM "+table+" WHERE user_id = $1", userID); err != nil {
			return err
		}
	}
	return nil
}
