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
	"encoding/json"
	"fmt"
	"reflect"

	"github.com/jiva-studio/shruti/profile/internal/domain/changes"
	"github.com/jiva-studio/shruti/profile/internal/domain/hlc"
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

// Plan is the corrective row one document needs.
type Plan struct {
	changes.DocKey
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
func PlanDoc(key changes.DocKey, rows []Row) (Plan, bool, error) {
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
// from what a publish writes: the master it replaced (the highest-hlc
// non-terminal row written before it) merged with origin='published'. It
// returns that expected data.
func stalePublish(rows []Row, master Row) (json.RawMessage, bool, error) {
	if !hlc.AtTerminal(master.HLC) || master.Op != changes.OpUpsert {
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
	if base == nil || base.Op != changes.OpUpsert {
		return nil, false, nil
	}
	var flip struct {
		TrackID string `json:"track_id"`
	}
	if err := json.Unmarshal(master.Data, &flip); err != nil {
		return nil, false, fmt.Errorf("decode publish row: %w", err)
	}
	expected, err := changes.PublishedData(base.Data, flip.TrackID)
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
