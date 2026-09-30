// Package push applies a device's batch of local changes to a user's change
// log, detecting a stale base and handing the master back as a conflict.
package push

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/profile/internal/domain/changes"
	"github.com/jiva-studio/shruti/profile/internal/ports"
)

// Item is one local change offered to the server. BaseHLC is the last-seen
// server hlc the device merged against; "" means a new document.
type Item struct {
	Collection string
	DocID      string
	Op         string
	Data       json.RawMessage
	HLC        string
	BaseHLC    string
}

// Request is a batch of local changes stamped with the writing device.
type Request struct {
	DeviceID string
	Changes  []Item
}

// Result lists what was applied and what came back as a conflict. Both are
// non-nil on success.
type Result struct {
	Applied   []changes.Ref
	Conflicts []changes.Conflict
}

// UseCase applies pushes.
type UseCase struct {
	tx ports.Transactor
}

// New builds the push use case.
func New(tx ports.Transactor) (*UseCase, error) {
	if tx == nil {
		return nil, errors.New("push: nil transactor")
	}
	return &UseCase{tx: tx}, nil
}

// Push applies a batch for one user. Each row is applied if its base_hlc
// matches the current master (or the doc is new); a row whose hlc equals the
// master is an idempotent retry; otherwise it is returned under Conflicts.
// The whole batch commits in one transaction under the user's lock, so
// global_seq is assigned in commit order. The batch is validated before any
// write, so a bad row fails it without a half-applied transaction; an upsert
// without data fails it only when it would be written.
func (u *UseCase) Push(ctx context.Context, userID uuid.UUID, req Request) (Result, error) {
	res := Result{Applied: []changes.Ref{}, Conflicts: []changes.Conflict{}}
	if req.DeviceID == "" {
		return res, changes.BadRequest("device_id is required")
	}
	for _, it := range req.Changes {
		if err := validate(it); err != nil {
			return res, err
		}
	}

	err := u.tx.WithinTx(ctx, func(tx ports.Tx) error {
		if err := tx.LockUser(ctx, userID); err != nil {
			return err
		}
		for _, it := range req.Changes {
			ref := changes.Ref{Collection: it.Collection, DocID: it.DocID}
			master, found, err := tx.Latest(ctx, userID, it.Collection, it.DocID)
			if err != nil {
				return err
			}
			switch {
			case found && master.HLC == it.HLC:
				res.Applied = append(res.Applied, ref)
				continue
			case found && it.BaseHLC != master.HLC:
				master.Collection, master.DocID = it.Collection, it.DocID
				res.Conflicts = append(res.Conflicts, changes.Conflict{
					Collection: it.Collection,
					DocID:      it.DocID,
					Master:     master,
				})
				continue
			}
			if it.Op == changes.OpUpsert && len(it.Data) == 0 {
				return changes.BadRequest("data is required for an upsert")
			}
			c := changes.Change{Collection: it.Collection, DocID: it.DocID, Op: it.Op, Data: it.Data, HLC: it.HLC}
			if err := tx.Append(ctx, userID, req.DeviceID, c); err != nil {
				return err
			}
			if err := tx.ApplyState(ctx, userID, c); err != nil {
				return err
			}
			res.Applied = append(res.Applied, ref)
		}
		return nil
	})
	if err != nil {
		return Result{}, err
	}
	return res, nil
}

// validate refuses a change a client may not push. A server-owned collection
// is refused before any write, so a device can never forge or overwrite
// server state.
func validate(it Item) error {
	if !changes.IsKnown(it.Collection) {
		return changes.BadRequest("unknown collection %q", it.Collection)
	}
	if changes.IsServerOwned(it.Collection) {
		return changes.Forbidden("server_owned_collection",
			"collection %q is server-owned and cannot be pushed", it.Collection)
	}
	if it.Op != changes.OpUpsert && it.Op != changes.OpDelete {
		return changes.BadRequest("invalid op %q (want upsert|delete)", it.Op)
	}
	if it.DocID == "" {
		return changes.BadRequest("doc_id is required")
	}
	if it.HLC == "" {
		return changes.BadRequest("hlc is required")
	}
	return nil
}
