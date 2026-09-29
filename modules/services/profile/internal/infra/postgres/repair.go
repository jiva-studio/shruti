package postgres

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/profile/internal/domain/changes"
)

// candidatesSQL narrows the scan to documents that can need repair: newest by
// global_seq differs from highest hlc, or the highest hlc matches $3.
const candidatesSQL = `
SELECT user_id, collection, doc_id FROM (
  SELECT user_id, collection, doc_id,
         (array_agg(global_seq ORDER BY global_seq DESC))[1]                          AS seq_top,
         (array_agg(global_seq ORDER BY hlc COLLATE "C" DESC, global_seq DESC))[1]    AS hlc_top,
         max(hlc COLLATE "C")                                                          AS max_hlc
    FROM profile.changes
   WHERE collection = ANY($1) AND ($2::uuid IS NULL OR user_id = $2)
   GROUP BY user_id, collection, doc_id
) d
WHERE seq_top <> hlc_top OR max_hlc LIKE $3
ORDER BY user_id, collection, doc_id`

// Candidates lists documents that can need a corrective row. terminalPattern
// is a LIKE pattern on the highest hlc.
func (s *Store) Candidates(ctx context.Context, collections []string, user *uuid.UUID, terminalPattern string) ([]changes.DocKey, error) {
	rows, err := s.pool.Query(ctx, candidatesSQL, collections, user, terminalPattern)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var keys []changes.DocKey
	for rows.Next() {
		var k changes.DocKey
		if err := rows.Scan(&k.UserID, &k.Collection, &k.DocID); err != nil {
			return nil, err
		}
		keys = append(keys, k)
	}
	return keys, rows.Err()
}

// DocChanges reads one document's rows without a transaction.
func (s *Store) DocChanges(ctx context.Context, key changes.DocKey) ([]changes.Change, error) {
	return docChanges(ctx, s.pool, key)
}

func docChanges(ctx context.Context, q querier, key changes.DocKey) ([]changes.Change, error) {
	rows, err := q.Query(ctx,
		`SELECT global_seq, op, data, hlc FROM profile.changes
		  WHERE user_id = $1 AND collection = $2 AND doc_id = $3
		  ORDER BY global_seq`,
		key.UserID, key.Collection, key.DocID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []changes.Change
	for rows.Next() {
		c := changes.Change{Collection: key.Collection, DocID: key.DocID}
		var data []byte
		if err := rows.Scan(&c.ServerSeq, &c.Op, &data, &c.HLC); err != nil {
			return nil, err
		}
		if len(data) > 0 {
			c.Data = json.RawMessage(data)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
