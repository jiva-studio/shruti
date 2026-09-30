package library_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/profile/internal/application/library"
	"github.com/jiva-studio/shruti/profile/internal/domain/changes"
	"github.com/jiva-studio/shruti/profile/internal/domain/hlc"
	"github.com/jiva-studio/shruti/profile/internal/ports"
)

type row struct {
	device string
	change changes.Change
}

// memLog is one user's library_items change log in memory, with the
// track-to-membership index the projection would hold.
type memLog struct {
	rows        []row
	state       map[string]changes.Change
	memberships map[string][]string
	locks       int
}

func newMemLog() *memLog {
	return &memLog{state: map[string]changes.Change{}, memberships: map[string][]string{}}
}

func (m *memLog) WithinTx(_ context.Context, fn func(ports.Tx) error) error {
	return fn(memTx{m: m})
}

type memTx struct {
	ports.Tx
	m *memLog
}

func (t memTx) LockUser(context.Context, uuid.UUID) error {
	t.m.locks++
	return nil
}

// Latest is the highest-hlc row, as for a server-owned collection.
func (t memTx) Latest(_ context.Context, _ uuid.UUID, collection, docID string) (changes.Change, bool, error) {
	var best changes.Change
	found := false
	for _, r := range t.m.rows {
		if r.change.Collection == collection && r.change.DocID == docID && (!found || r.change.HLC > best.HLC) {
			best, found = r.change, true
		}
	}
	return best, found, nil
}

func (t memTx) Append(_ context.Context, _ uuid.UUID, deviceID string, c changes.Change) error {
	t.m.rows = append(t.m.rows, row{device: deviceID, change: c})
	return nil
}

func (t memTx) ApplyState(_ context.Context, _ uuid.UUID, c changes.Change) error {
	t.m.state[c.DocID] = c
	return nil
}

func (t memTx) LibraryMembershipsByTrack(_ context.Context, _ uuid.UUID, trackID string) ([]string, error) {
	return t.m.memberships[trackID], nil
}

// LibraryTrackProjected scans the log for an upsert whose data carried trackID.
func (t memTx) LibraryTrackProjected(_ context.Context, _ uuid.UUID, trackID string) (bool, error) {
	for _, r := range t.m.rows {
		var data struct {
			TrackID string `json:"track_id"`
		}
		if r.change.Op != changes.OpUpsert || json.Unmarshal(r.change.Data, &data) != nil {
			continue
		}
		if data.TrackID == trackID {
			return true, nil
		}
	}
	return false, nil
}

func newLibrary(t *testing.T, m *memLog) *library.UseCase {
	t.Helper()
	uc, err := library.New(m)
	if err != nil {
		t.Fatal(err)
	}
	return uc
}

const (
	rankQueued  = 1
	rankReady   = 3
	rankRemoved = 4
)

func TestNewRefusesANilTransactor(t *testing.T) {
	if _, err := library.New(nil); err == nil {
		t.Fatal("library.New(nil) succeeded")
	}
}

func TestLifecycleRefusesABadEvent(t *testing.T) {
	cases := map[string]struct {
		docID, op string
		data      json.RawMessage
	}{
		"bad op":              {docID: "m1", op: "merge", data: json.RawMessage(`{}`)},
		"no doc id":           {op: changes.OpUpsert, data: json.RawMessage(`{}`)},
		"upsert with no data": {docID: "m1", op: changes.OpUpsert},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			m := newMemLog()
			_, err := newLibrary(t, m).ApplyLibraryLifecycle(t.Context(), uuid.New(), tc.docID, tc.op, 0, rankQueued, tc.data)
			if !changes.IsValidation(err) {
				t.Fatalf("err = %v, want a validation error", err)
			}
			if len(m.rows) != 0 || m.locks != 0 {
				t.Fatal("a refused event touched the log")
			}
		})
	}
}

// A later state wins however the events arrive: a lower state delivered after
// a higher one, and a redelivery, write nothing.
func TestLifecycleAppendsOnlyAHigherState(t *testing.T) {
	m := newMemLog()
	uc := newLibrary(t, m)
	ctx, user := t.Context(), uuid.New()
	ready := json.RawMessage(`{"status":"ready","title":"T"}`)

	c, err := uc.ApplyLibraryLifecycle(ctx, user, "m1", changes.OpUpsert, 0, rankReady, ready)
	if err != nil {
		t.Fatal(err)
	}
	if c.Collection != changes.LibraryItems || c.HLC != hlc.NewClock().Ranked(0, rankReady) {
		t.Fatalf("change = %+v", c)
	}
	if _, err := uc.ApplyLibraryLifecycle(ctx, user, "m1", changes.OpUpsert, 0, rankQueued, json.RawMessage(`{"status":"queued"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := uc.ApplyLibraryLifecycle(ctx, user, "m1", changes.OpUpsert, 0, rankReady, ready); err != nil {
		t.Fatal(err)
	}
	if len(m.rows) != 1 || m.rows[0].device != hlc.ServerNodeID {
		t.Fatalf("log = %+v", m.rows)
	}
	if string(m.state["m1"].Data) != string(ready) {
		t.Fatalf("state = %s", m.state["m1"].Data)
	}

	// A re-run of the job lifts its states above the earlier run's.
	if _, err := uc.ApplyLibraryLifecycle(ctx, user, "m1", changes.OpUpsert, 1, rankQueued, json.RawMessage(`{"status":"queued"}`)); err != nil {
		t.Fatal(err)
	}
	if len(m.rows) != 2 {
		t.Fatalf("re-run not appended: %d rows", len(m.rows))
	}
}

func TestMarkPublishedFlipsEachMembershipKeepingItsData(t *testing.T) {
	m := newMemLog()
	uc := newLibrary(t, m)
	ctx, user := t.Context(), uuid.New()
	if _, err := uc.ApplyLibraryLifecycle(ctx, user, "m1", changes.OpUpsert, 0, rankReady, json.RawMessage(`{"title":"T","track_id":"trk"}`)); err != nil {
		t.Fatal(err)
	}
	m.memberships["trk"] = []string{"m1", "m2"}

	if err := uc.MarkPublished(ctx, user, "trk"); err != nil {
		t.Fatal(err)
	}
	var m1, m2 map[string]string
	if err := json.Unmarshal(m.state["m1"].Data, &m1); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(m.state["m2"].Data, &m2); err != nil {
		t.Fatal(err)
	}
	if m1["origin"] != "published" || m1["title"] != "T" || m1["track_id"] != "trk" {
		t.Fatalf("m1 = %v", m1)
	}
	if m2["origin"] != "published" || m2["track_id"] != "trk" {
		t.Fatalf("m2 = %v", m2)
	}
	if m.state["m1"].HLC != hlc.NewClock().Terminal() {
		t.Fatalf("flip hlc = %s, want terminal", m.state["m1"].HLC)
	}

	rows := len(m.rows)
	if err := uc.MarkPublished(ctx, user, "trk"); err != nil {
		t.Fatal(err)
	}
	if len(m.rows) != rows {
		t.Fatal("a redelivered promotion wrote again")
	}
	// A lifecycle state after the flip cannot undo it.
	if _, err := uc.ApplyLibraryLifecycle(ctx, user, "m1", changes.OpUpsert, 3, rankReady, json.RawMessage(`{}`)); err != nil {
		t.Fatal(err)
	}
	if len(m.rows) != rows {
		t.Fatal("a lifecycle state superseded the publish flip")
	}
}

func TestMarkPublishedBeforeReadyIsNotProjected(t *testing.T) {
	m := newMemLog()
	err := newLibrary(t, m).MarkPublished(t.Context(), uuid.New(), "trk")
	if !errors.Is(err, changes.ErrNotProjected) {
		t.Fatalf("err = %v, want ErrNotProjected", err)
	}
	if len(m.rows) != 0 {
		t.Fatalf("rows = %d", len(m.rows))
	}
}

func TestMarkPublishedAfterRemovalWritesNothing(t *testing.T) {
	m := newMemLog()
	uc := newLibrary(t, m)
	ctx, user := t.Context(), uuid.New()
	if _, err := uc.ApplyLibraryLifecycle(ctx, user, "m1", changes.OpUpsert, 0, rankReady, json.RawMessage(`{"status":"ready","track_id":"trk"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := uc.ApplyLibraryLifecycle(ctx, user, "m1", changes.OpDelete, 0, rankRemoved, nil); err != nil {
		t.Fatal(err)
	}
	rows := len(m.rows)

	if err := uc.MarkPublished(ctx, user, "trk"); err != nil {
		t.Fatalf("err = %v, want nil for a removed item", err)
	}
	if len(m.rows) != rows {
		t.Fatalf("a flip was written for a removed item: %d rows, want %d", len(m.rows), rows)
	}
}

func TestMarkPublishedRefusesAnEmptyTrack(t *testing.T) {
	m := newMemLog()
	if err := newLibrary(t, m).MarkPublished(t.Context(), uuid.New(), ""); !changes.IsValidation(err) {
		t.Fatalf("err = %v, want a validation error", err)
	}
}

func TestMarkPublishedPassesACorruptMasterOn(t *testing.T) {
	m := newMemLog()
	m.rows = append(m.rows, row{change: changes.Change{Collection: changes.LibraryItems, DocID: "m1", HLC: "0", Data: json.RawMessage(`[`)}})
	m.memberships["trk"] = []string{"m1"}
	err := newLibrary(t, m).MarkPublished(t.Context(), uuid.New(), "trk")
	var syntax *json.SyntaxError
	if !errors.As(err, &syntax) {
		t.Fatalf("err = %v, want a decode error", err)
	}
	if len(m.rows) != 1 {
		t.Fatal("a flip was written over an unreadable master")
	}
}
