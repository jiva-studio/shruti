package postgres

import (
	"context"
	"encoding/json"

	"github.com/jiva-studio/shruti/profile/internal/domain/changes"
)

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
