package push_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/profile/internal/application/push"
	"github.com/jiva-studio/shruti/profile/internal/domain/changes"
	"github.com/jiva-studio/shruti/profile/internal/ports"
)

type row struct {
	user   uuid.UUID
	device string
	change changes.Change
}

// memLog is an in-memory change log. A unit of work that fails leaves it as
// it was, like a rolled-back transaction.
type memLog struct {
	rows      []row
	state     map[changes.Ref]changes.Change
	locked    []uuid.UUID
	appendErr error
}

func newMemLog() *memLog { return &memLog{state: map[changes.Ref]changes.Change{}} }

func (m *memLog) WithinTx(_ context.Context, fn func(ports.Tx) error) error {
	rows := append([]row(nil), m.rows...)
	state := make(map[changes.Ref]changes.Change, len(m.state))
	for k, v := range m.state {
		state[k] = v
	}
	if err := fn(memTx{m}); err != nil {
		m.rows, m.state = rows, state
		return err
	}
	return nil
}

type memTx struct{ m *memLog }

var _ ports.Tx = memTx{}

func (t memTx) LockUser(_ context.Context, userID uuid.UUID) error {
	t.m.locked = append(t.m.locked, userID)
	return nil
}

func (t memTx) Latest(_ context.Context, userID uuid.UUID, collection, docID string) (changes.Change, bool, error) {
	for i := len(t.m.rows) - 1; i >= 0; i-- {
		r := t.m.rows[i]
		if r.user == userID && r.change.Collection == collection && r.change.DocID == docID {
			return r.change, true, nil
		}
	}
	return changes.Change{}, false, nil
}

func (t memTx) Append(_ context.Context, userID uuid.UUID, deviceID string, c changes.Change) error {
	if t.m.appendErr != nil {
		return t.m.appendErr
	}
	c.ServerSeq = int64(len(t.m.rows) + 1)
	t.m.rows = append(t.m.rows, row{user: userID, device: deviceID, change: c})
	return nil
}

func (t memTx) ApplyState(_ context.Context, _ uuid.UUID, c changes.Change) error {
	t.m.state[changes.Ref{Collection: c.Collection, DocID: c.DocID}] = c
	return nil
}

func (memTx) LibraryMembershipsByTrack(context.Context, uuid.UUID, string) ([]string, error) {
	return nil, errors.New("not used by push")
}

func (memTx) LibraryTrackProjected(context.Context, uuid.UUID, string) (bool, error) {
	return false, errors.New("not used by push")
}

func (memTx) DocChanges(context.Context, changes.DocKey) ([]changes.Change, error) {
	return nil, errors.New("not used by push")
}

func (memTx) PurgeUser(context.Context, uuid.UUID) error { return errors.New("not used by push") }

func newPush(t *testing.T, m *memLog) *push.UseCase {
	t.Helper()
	uc, err := push.New(m)
	if err != nil {
		t.Fatal(err)
	}
	return uc
}

func note(docID, hlc, base string) push.Item {
	return push.Item{Collection: "notes", DocID: docID, Op: changes.OpUpsert, Data: json.RawMessage(`{"t":"x"}`), HLC: hlc, BaseHLC: base}
}

func TestNewRefusesANilTransactor(t *testing.T) {
	if _, err := push.New(nil); err == nil {
		t.Fatal("push.New(nil) succeeded")
	}
}

func TestPushAppliesANewDocumentUnderTheUserLock(t *testing.T) {
	m := newMemLog()
	user := uuid.New()
	res, err := newPush(t, m).Push(t.Context(), user, push.Request{DeviceID: "dev-1", Changes: []push.Item{note("n1", "h1", "")}})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Applied) != 1 || res.Applied[0] != (changes.Ref{Collection: "notes", DocID: "n1"}) || len(res.Conflicts) != 0 {
		t.Fatalf("result = %+v", res)
	}
	if len(m.locked) != 1 || m.locked[0] != user {
		t.Fatalf("user lock = %v", m.locked)
	}
	if len(m.rows) != 1 || m.rows[0].device != "dev-1" || m.rows[0].change.HLC != "h1" {
		t.Fatalf("log = %+v", m.rows)
	}
	if got := m.state[changes.Ref{Collection: "notes", DocID: "n1"}]; got.HLC != "h1" {
		t.Fatalf("state = %+v", got)
	}
}

func TestPushOfTheMasterHLCIsAnIdempotentRetry(t *testing.T) {
	m := newMemLog()
	user := uuid.New()
	uc := newPush(t, m)
	req := push.Request{DeviceID: "dev-1", Changes: []push.Item{note("n1", "h1", "")}}
	if _, err := uc.Push(t.Context(), user, req); err != nil {
		t.Fatal(err)
	}
	res, err := uc.Push(t.Context(), user, req)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Applied) != 1 || len(res.Conflicts) != 0 {
		t.Fatalf("retry result = %+v", res)
	}
	if len(m.rows) != 1 {
		t.Fatalf("retry appended: %d rows", len(m.rows))
	}
}

func TestPushOnTheMasterBaseApplies(t *testing.T) {
	m := newMemLog()
	user := uuid.New()
	uc := newPush(t, m)
	if _, err := uc.Push(t.Context(), user, push.Request{DeviceID: "dev-1", Changes: []push.Item{note("n1", "h1", "")}}); err != nil {
		t.Fatal(err)
	}
	res, err := uc.Push(t.Context(), user, push.Request{DeviceID: "dev-2", Changes: []push.Item{note("n1", "h2", "h1")}})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Applied) != 1 || len(res.Conflicts) != 0 || len(m.rows) != 2 {
		t.Fatalf("result = %+v, rows = %d", res, len(m.rows))
	}
}

func TestPushOnAStaleBaseReturnsTheMasterAsAConflict(t *testing.T) {
	m := newMemLog()
	user := uuid.New()
	uc := newPush(t, m)
	if _, err := uc.Push(t.Context(), user, push.Request{DeviceID: "dev-1", Changes: []push.Item{note("n1", "h2", "")}}); err != nil {
		t.Fatal(err)
	}
	res, err := uc.Push(t.Context(), user, push.Request{DeviceID: "dev-2", Changes: []push.Item{
		note("n1", "h3", "h1"),
		note("n2", "h1", ""),
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Conflicts) != 1 {
		t.Fatalf("conflicts = %+v", res.Conflicts)
	}
	c := res.Conflicts[0]
	if c.Collection != "notes" || c.DocID != "n1" || c.Master.HLC != "h2" || c.Master.Collection != "notes" || c.Master.DocID != "n1" {
		t.Fatalf("conflict = %+v", c)
	}
	if len(res.Applied) != 1 || res.Applied[0].DocID != "n2" {
		t.Fatalf("applied = %+v", res.Applied)
	}
	if len(m.rows) != 2 {
		t.Fatalf("a conflicting row was written: %d rows", len(m.rows))
	}
}

// A batch with one bad row is refused before anything is written.
func TestPushRefusesABadBatchWithoutWriting(t *testing.T) {
	good := note("n1", "h1", "")
	cases := map[string]struct {
		req       push.Request
		forbidden bool
	}{
		"no device":           {req: push.Request{Changes: []push.Item{good}}},
		"unknown collection":  {req: push.Request{DeviceID: "d", Changes: []push.Item{good, {Collection: "nope", DocID: "x", Op: changes.OpUpsert, HLC: "h"}}}},
		"server-owned":        {req: push.Request{DeviceID: "d", Changes: []push.Item{good, {Collection: changes.LibraryItems, DocID: "x", Op: changes.OpUpsert, HLC: "h"}}}, forbidden: true},
		"bad op":              {req: push.Request{DeviceID: "d", Changes: []push.Item{good, {Collection: "notes", DocID: "x", Op: "merge", HLC: "h"}}}},
		"no doc id":           {req: push.Request{DeviceID: "d", Changes: []push.Item{good, {Collection: "notes", Op: changes.OpDelete, HLC: "h"}}}},
		"no hlc":              {req: push.Request{DeviceID: "d", Changes: []push.Item{good, {Collection: "notes", DocID: "x", Op: changes.OpDelete}}}},
		"upsert with no data": {req: push.Request{DeviceID: "d", Changes: []push.Item{good, {Collection: "notes", DocID: "x", Op: changes.OpUpsert, HLC: "h"}}}},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			m := newMemLog()
			_, err := newPush(t, m).Push(t.Context(), uuid.New(), tc.req)
			if tc.forbidden {
				if f, ok := changes.AsForbidden(err); !ok || f.Code != "server_owned_collection" {
					t.Fatalf("err = %v, want server_owned_collection", err)
				}
			} else if !changes.IsValidation(err) {
				t.Fatalf("err = %v, want a validation error", err)
			}
			if len(m.rows) != 0 || len(m.locked) != 0 {
				t.Fatalf("a refused batch touched the log: rows=%d locks=%d", len(m.rows), len(m.locked))
			}
		})
	}
}

// A write that fails rolls the whole batch back and returns no partial
// result.
func TestPushThatFailsMidBatchReturnsNothing(t *testing.T) {
	m := newMemLog()
	m.appendErr = errors.New("disk full")
	res, err := newPush(t, m).Push(t.Context(), uuid.New(), push.Request{DeviceID: "d", Changes: []push.Item{note("n1", "h1", "")}})
	if !errors.Is(err, m.appendErr) {
		t.Fatalf("err = %v", err)
	}
	if res.Applied != nil || res.Conflicts != nil {
		t.Fatalf("partial result on failure: %+v", res)
	}
}
