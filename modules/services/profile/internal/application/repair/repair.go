package repair

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/profile/internal/domain/changes"
	"github.com/jiva-studio/shruti/profile/internal/domain/hlc"
	"github.com/jiva-studio/shruti/profile/internal/ports"
)

// Repairer scans and repairs one profile database.
type Repairer struct {
	scan ports.RepairScan
	tx   ports.Transactor
	// user limits the scan to one user when set.
	user *uuid.UUID
}

// New builds a Repairer; user, when non-nil, limits it to one user.
func New(scan ports.RepairScan, tx ports.Transactor, user *uuid.UUID) (*Repairer, error) {
	if scan == nil || tx == nil {
		return nil, errors.New("repair: nil scan or transactor")
	}
	return &Repairer{scan: scan, tx: tx, user: user}, nil
}

// Scan returns a plan for every document that needs repair, read without
// locks; Apply re-plans each one under its user's lock before writing.
func (r *Repairer) Scan(ctx context.Context) ([]Plan, error) {
	keys, err := r.scan.Candidates(ctx, changes.ServerOwnedCollections(), r.user, hlc.TerminalPrefix()+"%")
	if err != nil {
		return nil, err
	}
	var plans []Plan
	for _, key := range keys {
		log, err := r.scan.DocChanges(ctx, key)
		if err != nil {
			return nil, err
		}
		plan, ok, err := PlanDoc(key, rowsOf(log))
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
// per-user lock every write takes. The plan is recomputed inside the
// transaction, so a document fixed or changed in the meantime is repaired
// against its current rows, or skipped. It returns the plans it wrote.
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

func (r *Repairer) applyOne(ctx context.Context, key changes.DocKey) (Plan, bool, error) {
	var (
		plan Plan
		ok   bool
	)
	err := r.tx.WithinTx(ctx, func(tx ports.Tx) error {
		if err := tx.LockUser(ctx, key.UserID); err != nil {
			return err
		}
		log, err := tx.DocChanges(ctx, key)
		if err != nil {
			return err
		}
		plan, ok, err = PlanDoc(key, rowsOf(log))
		if err != nil || !ok {
			return err
		}
		c := changes.Change{Collection: key.Collection, DocID: key.DocID, Op: plan.Op, Data: plan.Data, HLC: plan.HLC}
		if err := tx.Append(ctx, key.UserID, hlc.ServerNodeID, c); err != nil {
			return err
		}
		return tx.ApplyState(ctx, key.UserID, c)
	})
	if err != nil || !ok {
		return Plan{}, false, err
	}
	return plan, true, nil
}

func rowsOf(log []changes.Change) []Row {
	out := make([]Row, 0, len(log))
	for _, c := range log {
		out = append(out, Row{Seq: c.ServerSeq, Op: c.Op, Data: c.Data, HLC: c.HLC})
	}
	return out
}
