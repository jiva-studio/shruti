package store

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti/profile/internal/wire"
)

// ChangesRepo reads and appends the append-only change log.
type ChangesRepo struct{ Pool *pgxpool.Pool }

// MasterChange is the latest change-log row for a document — the current
// master used for optimistic-concurrency (base_hlc) comparison and returned
// inside a conflict.
type MasterChange struct {
	ServerSeq int64
	Op        string
	Data      json.RawMessage
	HLC       string
}

// Latest returns the newest change for (user, collection, doc), or found=false
// when the document has never been written.
func (r *ChangesRepo) Latest(ctx context.Context, q querier, userID uuid.UUID, collection, docID string) (MasterChange, bool, error) {
	var m MasterChange
	err := q.QueryRow(ctx,
		`SELECT global_seq, op, data, hlc
		   FROM profile.changes
		  WHERE user_id = $1 AND collection = $2 AND doc_id = $3
		  ORDER BY global_seq DESC
		  LIMIT 1`,
		userID, collection, docID,
	).Scan(&m.ServerSeq, &m.Op, &m.Data, &m.HLC)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return MasterChange{}, false, nil
		}
		return MasterChange{}, false, err
	}
	return m, true, nil
}

// Append inserts a change-log row. The UNIQUE (user_id, collection, doc_id,
// hlc) constraint makes a retried push a no-op (ON CONFLICT DO NOTHING).
func (r *ChangesRepo) Append(ctx context.Context, q querier, userID uuid.UUID, deviceID string, it wire.PushItem) error {
	var data any
	if it.Op == "delete" || len(it.Data) == 0 {
		data = nil
	} else {
		data = []byte(it.Data)
	}
	_, err := q.Exec(ctx,
		`INSERT INTO profile.changes (user_id, collection, doc_id, op, data, hlc, device_id)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 ON CONFLICT (user_id, collection, doc_id, hlc) DO NOTHING`,
		userID, it.Collection, it.DocID, it.Op, data, it.HLC, deviceID,
	)
	return err
}

// Pull returns changes for the user with global_seq > cursor, ordered by
// global_seq, up to limit rows. A device receives its OWN writes back too:
// re-applying them is idempotent (LWW on the same HLC is a no-op), and it is
// the only way a device that lost its local copy (reinstall/wipe) can recover
// its own data — echo-suppression here would make that loss permanent.
func (r *ChangesRepo) Pull(ctx context.Context, userID uuid.UUID, cursor int64, limit int) ([]wire.Change, error) {
	rows, err := r.Pool.Query(ctx,
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

	out := make([]wire.Change, 0, limit)
	for rows.Next() {
		var c wire.Change
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
