// Package repair finds server-owned documents whose change log would lead an
// installed client to the wrong state, and appends one corrective row per
// document.
//
// Installed clients apply pulled library_items rows in global_seq order and
// take each one wholesale, so the state a client ends on is the newest row by
// global_seq, while the server's master is the row with the highest hlc. A
// document needs repair when:
//
//   - misordered: its newest row by global_seq is not its highest-hlc row;
//   - stale_publish: its highest-hlc row is a publish flip whose data is not the
//     master it replaced (the highest-hlc earlier non-terminal row) merged with
//     origin='published'.
//
// The corrective row carries the correct state under hlc.Successor of the
// highest stamp, so it is both the newest row by global_seq and the new
// master. On a published document that stamp is physicalMod-1 with counter 1,
// the only stamps above Terminal. Running the repair again finds nothing.
package repair

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti/profile/internal/hlc"
	"github.com/jiva-studio/shruti/profile/internal/service"
	"github.com/jiva-studio/shruti/profile/internal/store"
	"github.com/jiva-studio/shruti/profile/internal/wire"
)

// Reasons a document needs repair.
const (
	ReasonMisordered   = "misordered"
	ReasonStalePublish = "stale_publish"
)

// Row is one change-log row of a document.
type Row struct {
	Seq  int64
	Op   string
	Data json.RawMessage
	HLC  string
}

// DocKey identifies one document.
type DocKey struct {
	UserID     uuid.UUID
	Collection string
	DocID      string
}

// Plan is the corrective row one document needs.
type Plan struct {
	DocKey
	Reason string
	// Newest is the row installed clients currently end on.
	Newest Row
	// Master is the highest-hlc row.
	Master Row
	// Op, Data and HLC are the corrective row.
	Op   string
	Data json.RawMessage
	HLC  string
}

// PlanDoc decides whether a document's rows (any order) need a corrective row.
// ok is false when the log is already consistent.
func PlanDoc(key DocKey, rows []Row) (Plan, bool, error) {
	if len(rows) == 0 {
		return Plan{}, false, nil
	}
	newest, master := rows[0], rows[0]
	for _, r := range rows[1:] {
		if r.Seq > newest.Seq {
			newest = r
		}
		if r.HLC > master.HLC || (r.HLC == master.HLC && r.Seq > master.Seq) {
			master = r
		}
	}

	plan := Plan{DocKey: key, Newest: newest, Master: master, Op: master.Op, Data: master.Data}
	expected, stale, err := stalePublish(rows, master)
	if err != nil {
		return Plan{}, false, fmt.Errorf("%s/%s: %w", key.Collection, key.DocID, err)
	}
	switch {
	case stale:
		plan.Reason, plan.Data = ReasonStalePublish, expected
	case newest.Seq != master.Seq:
		plan.Reason = ReasonMisordered
	default:
		return Plan{}, false, nil
	}
	next, err := hlc.Successor(master.HLC)
	if err != nil {
		return Plan{}, false, fmt.Errorf("%s/%s: %w", key.Collection, key.DocID, err)
	}
	plan.HLC = next
	return plan, true, nil
}

// stalePublish reports whether master is a publish flip whose data differs
// from what MarkPublished writes today: the master it replaced (the
// highest-hlc non-terminal row written before it) merged with
// origin='published'. It returns that expected data.
func stalePublish(rows []Row, master Row) (json.RawMessage, bool, error) {
	if !hlc.AtTerminal(master.HLC) || master.Op != "upsert" {
		return nil, false, nil
	}
	var base *Row
	for i := range rows {
		r := &rows[i]
		if r.Seq >= master.Seq || hlc.AtTerminal(r.HLC) {
			continue
		}
		if base == nil || r.HLC > base.HLC {
			base = r
		}
	}
	if base == nil || base.Op != "upsert" {
		return nil, false, nil
	}
	var flip struct {
		TrackID string `json:"track_id"`
	}
	if err := json.Unmarshal(master.Data, &flip); err != nil {
		return nil, false, fmt.Errorf("decode publish row: %w", err)
	}
	expected, err := service.PublishedData(base.Data, flip.TrackID)
	if err != nil {
		return nil, false, err
	}
	same, err := jsonEqual(expected, master.Data)
	if err != nil {
		return nil, false, err
	}
	return expected, !same, nil
}

func jsonEqual(a, b json.RawMessage) (bool, error) {
	var va, vb any
	if err := json.Unmarshal(a, &va); err != nil {
		return false, err
	}
	if err := json.Unmarshal(b, &vb); err != nil {
		return false, err
	}
	return reflect.DeepEqual(va, vb), nil
}

// candidatesSQL narrows the scan to documents that can need repair: newest by
// global_seq differs from highest hlc, or the highest hlc is a publish flip.
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

// Repairer scans and repairs one profile database.
type Repairer struct {
	Pool *pgxpool.Pool
	// User limits the scan to one user when set.
	User *uuid.UUID
}

// Scan returns a plan for every document that needs repair, read without
// locks; Apply re-plans each one under its user's lock before writing.
func (r *Repairer) Scan(ctx context.Context) ([]Plan, error) {
	keys, err := r.candidates(ctx)
	if err != nil {
		return nil, err
	}
	var plans []Plan
	for _, key := range keys {
		rows, err := docRows(ctx, r.Pool, key)
		if err != nil {
			return nil, err
		}
		plan, ok, err := PlanDoc(key, rows)
		if err != nil {
			return nil, err
		}
		if ok {
			plans = append(plans, plan)
		}
	}
	return plans, nil
}

// Apply repairs each planned document in its own transaction under the
// per-user advisory lock the service writes under. The plan is recomputed
// inside the transaction, so a document the service fixed or changed in the
// meantime is repaired against its current rows, or skipped. It returns the
// plans it wrote.
func (r *Repairer) Apply(ctx context.Context, plans []Plan) ([]Plan, error) {
	var applied []Plan
	for _, p := range plans {
		plan, ok, err := r.applyOne(ctx, p.DocKey)
		if err != nil {
			return applied, fmt.Errorf("repair %s %s/%s: %w", p.UserID, p.Collection, p.DocID, err)
		}
		if ok {
			applied = append(applied, plan)
		}
	}
	return applied, nil
}

func (r *Repairer) applyOne(ctx context.Context, key DocKey) (Plan, bool, error) {
	tx, err := r.Pool.Begin(ctx)
	if err != nil {
		return Plan{}, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := store.AdvisoryXactLock(ctx, tx, key.UserID); err != nil {
		return Plan{}, false, err
	}
	rows, err := docRows(ctx, tx, key)
	if err != nil {
		return Plan{}, false, err
	}
	plan, ok, err := PlanDoc(key, rows)
	if err != nil || !ok {
		return Plan{}, false, err
	}
	it := wire.PushItem{Collection: key.Collection, DocID: key.DocID, Op: plan.Op, Data: plan.Data, HLC: plan.HLC}
	changes := store.ChangesRepo{}
	if err := changes.Append(ctx, tx, key.UserID, hlc.ServerNodeID, it); err != nil {
		return Plan{}, false, err
	}
	if err := store.ApplyState(ctx, tx, key.UserID, it); err != nil {
		return Plan{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Plan{}, false, err
	}
	return plan, true, nil
}

func (r *Repairer) candidates(ctx context.Context) ([]DocKey, error) {
	collections := make([]string, 0, len(store.ServerOwned))
	for c := range store.ServerOwned {
		collections = append(collections, c)
	}
	rows, err := r.Pool.Query(ctx, candidatesSQL, collections, r.User, hlc.TerminalPrefix()+"%")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var keys []DocKey
	for rows.Next() {
		var k DocKey
		if err := rows.Scan(&k.UserID, &k.Collection, &k.DocID); err != nil {
			return nil, err
		}
		keys = append(keys, k)
	}
	return keys, rows.Err()
}

type rowQuerier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

func docRows(ctx context.Context, q rowQuerier, key DocKey) ([]Row, error) {
	rows, err := q.Query(ctx,
		`SELECT global_seq, op, data, hlc FROM profile.changes
		  WHERE user_id = $1 AND collection = $2 AND doc_id = $3
		  ORDER BY global_seq`,
		key.UserID, key.Collection, key.DocID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Row
	for rows.Next() {
		var r Row
		var data []byte
		if err := rows.Scan(&r.Seq, &r.Op, &data, &r.HLC); err != nil {
			return nil, err
		}
		if len(data) > 0 {
			r.Data = json.RawMessage(data)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
