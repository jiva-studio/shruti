package service

import (
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"testing"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/profile/internal/hlc"
	"github.com/jiva-studio/shruti/profile/internal/wire"
)

// lifecycleEvent is one track.events delivery as ApplyLibraryLifecycle sees it.
type lifecycleEvent struct {
	generation, rank int
	op, status       string
}

func (e lifecycleEvent) data() json.RawMessage {
	if e.op == "delete" {
		return nil
	}
	return json.RawMessage(fmt.Sprintf(`{"status":%q,"track_id":"trk-1"}`, e.status))
}

func (e lifecycleEvent) hlc() string { return hlc.NewClock().Ranked(e.generation, e.rank) }

// permutations returns every ordering of events.
func permutations(events []lifecycleEvent) [][]lifecycleEvent {
	if len(events) <= 1 {
		return [][]lifecycleEvent{append([]lifecycleEvent(nil), events...)}
	}
	var out [][]lifecycleEvent
	for i := range events {
		rest := make([]lifecycleEvent, 0, len(events)-1)
		rest = append(rest, events[:i]...)
		rest = append(rest, events[i+1:]...)
		for _, p := range permutations(rest) {
			out = append(out, append([]lifecycleEvent{events[i]}, p...))
		}
	}
	return out
}

// withDuplicate re-inserts a copy of one delivery at a later position, the way
// an at-least-once broker redelivers.
func withDuplicate(rng *rand.Rand, seq []lifecycleEvent) []lifecycleEvent {
	from := rng.IntN(len(seq))
	at := from + 1 + rng.IntN(len(seq)-from)
	out := make([]lifecycleEvent, 0, len(seq)+1)
	out = append(out, seq[:at]...)
	out = append(out, seq[from])
	return append(out, seq[at:]...)
}

// For any arrival order of a membership's lifecycle events, with or without a
// redelivery, the projection, the master and the newest pulled row all equal
// the max-hlc event, and the pulled rows ascend in hlc — so an installed
// client that applies each pulled row wholesale never steps backwards.
func TestLifecycleAnyArrivalOrderConvergesOnMaxHLC(t *testing.T) {
	svc := newService(t, 0)
	ctx := t.Context()
	rng := rand.New(rand.NewPCG(7, 11))

	sets := map[string][]lifecycleEvent{
		"retry": {
			{0, 1, "upsert", "queued"},
			{0, 2, "upsert", "processing"},
			{0, 3, "upsert", "failed"},
			{1, 1, "upsert", "queued"},
			{1, 3, "upsert", "ready"},
		},
		"removed": {
			{0, 1, "upsert", "queued"},
			{0, 2, "upsert", "processing"},
			{0, 3, "upsert", "ready"},
			{0, 4, "delete", ""},
		},
	}
	for name, events := range sets {
		want := events[0]
		for _, e := range events[1:] {
			if e.hlc() > want.hlc() {
				want = e
			}
		}
		for i, perm := range permutations(events) {
			for _, seq := range [][]lifecycleEvent{perm, withDuplicate(rng, perm)} {
				uid := uuid.New()
				docID := fmt.Sprintf("%s-%d", name, i)
				for _, e := range seq {
					if _, err := svc.ApplyLibraryLifecycle(ctx, uid, docID, e.op, e.generation, e.rank, e.data()); err != nil {
						t.Fatalf("apply %+v: %v", e, err)
					}
				}
				assertConverged(t, svc, uid, docID, want, seq)
			}
		}
	}
}

func assertConverged(t *testing.T, svc *Service, uid uuid.UUID, docID string, want lifecycleEvent, seq []lifecycleEvent) {
	t.Helper()
	ctx := t.Context()

	master, found, err := svc.Changes.Latest(ctx, svc.Pool, uid, "library_items", docID)
	if err != nil || !found {
		t.Fatalf("%v: master: found=%v err=%v", seq, found, err)
	}
	if master.HLC != want.hlc() || master.Op != want.op {
		t.Fatalf("%v: master is %s/%s, want %s/%s", seq, master.Op, master.HLC, want.op, want.hlc())
	}

	var status *string
	err = svc.Pool.QueryRow(ctx,
		`SELECT status FROM profile.library_items WHERE user_id=$1 AND doc_id=$2`, uid, docID,
	).Scan(&status)
	switch {
	case want.op == "delete":
		if err == nil {
			t.Fatalf("%v: projection must be deleted, has status %v", seq, status)
		}
	case err != nil:
		t.Fatalf("%v: projection: %v", seq, err)
	case status == nil || *status != want.status:
		t.Fatalf("%v: projection status %v, want %s", seq, status, want.status)
	}

	page, err := svc.Pull(ctx, uid, wire.PullRequest{Cursor: 0, Limit: 500})
	if err != nil {
		t.Fatalf("pull: %v", err)
	}
	var last wire.Change
	for i, c := range page.Changes {
		if i > 0 && c.HLC <= last.HLC {
			t.Fatalf("%v: pulled row %s follows %s — a client would step backwards", seq, c.HLC, last.HLC)
		}
		last = c
	}
	if last.HLC != want.hlc() || last.Op != want.op {
		t.Fatalf("%v: newest pulled row is %s/%s, want %s/%s", seq, last.Op, last.HLC, want.op, want.hlc())
	}
	if want.op == "upsert" {
		var got map[string]string
		if err := json.Unmarshal(last.Data, &got); err != nil {
			t.Fatalf("%v: decode pulled data %s: %v", seq, last.Data, err)
		}
		if got["status"] != want.status {
			t.Fatalf("%v: newest pulled status %q, want %q", seq, got["status"], want.status)
		}
	}
}

// seedRawChange appends a library_items row straight into the change log,
// bypassing the write gate, to build a log whose global_seq order disagrees
// with its hlc order.
func seedRawChange(t *testing.T, svc *Service, uid uuid.UUID, docID, hlcStr, data string) {
	t.Helper()
	if _, err := svc.Pool.Exec(t.Context(),
		`INSERT INTO profile.changes (user_id, collection, doc_id, op, data, hlc, device_id)
		 VALUES ($1, 'library_items', $2, 'upsert', $3, $4, $5)`,
		uid, docID, data, hlcStr, hlc.ServerNodeID); err != nil {
		t.Fatalf("seed change: %v", err)
	}
}

// On a log where a lower-rank row sits above the ready row by global_seq, the
// master is still the ready row: the publish flip merges ready's data.
func TestMarkPublishedOnMisorderedLogUsesMaxHLCMaster(t *testing.T) {
	svc := newService(t, 0)
	ctx := t.Context()
	uid := uuid.New()
	clock := hlc.NewClock()

	ready := `{"status":"ready","track_id":"trk-l","audio_key":"a/l.mp3"}`
	seedRawChange(t, svc, uid, "lib-l", clock.Ranked(0, 3), ready)
	seedRawChange(t, svc, uid, "lib-l", clock.Ranked(0, 2), `{"status":"processing","track_id":"trk-l"}`)
	if _, err := svc.Pool.Exec(ctx,
		`INSERT INTO profile.library_items (user_id, doc_id, track_id, status, audio_key)
		 VALUES ($1, 'lib-l', 'trk-l', 'ready', 'a/l.mp3')`, uid); err != nil {
		t.Fatalf("seed projection: %v", err)
	}

	if err := svc.MarkPublished(ctx, uid, "trk-l"); err != nil {
		t.Fatalf("mark published: %v", err)
	}
	master, _, err := svc.Changes.Latest(ctx, svc.Pool, uid, "library_items", "lib-l")
	if err != nil {
		t.Fatalf("latest: %v", err)
	}
	var data map[string]string
	if err := json.Unmarshal(master.Data, &data); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if master.HLC != clock.Terminal() || data["status"] != "ready" || data["audio_key"] != "a/l.mp3" {
		t.Fatalf("publish flip must merge the ready row, got %s %v", master.HLC, data)
	}
}

// A late lower-rank event between ready and the publish flip must not leak
// into the flip: the terminal row merges origin into the ready data.
func TestMarkPublishedMergesMaxHLCState(t *testing.T) {
	svc := newService(t, 0)
	ctx := t.Context()
	uid := uuid.New()

	ready := json.RawMessage(`{"status":"ready","track_id":"trk-p","audio_key":"a/p.mp3"}`)
	if _, err := svc.ApplyLibraryLifecycle(ctx, uid, "lib-p", "upsert", 0, 3, ready); err != nil {
		t.Fatalf("ready: %v", err)
	}
	late := json.RawMessage(`{"status":"processing","track_id":"trk-p"}`)
	if _, err := svc.ApplyLibraryLifecycle(ctx, uid, "lib-p", "upsert", 0, 2, late); err != nil {
		t.Fatalf("late processing: %v", err)
	}
	if err := svc.MarkPublished(ctx, uid, "trk-p"); err != nil {
		t.Fatalf("mark published: %v", err)
	}
	if err := svc.MarkPublished(ctx, uid, "trk-p"); err != nil {
		t.Fatalf("mark published redelivery: %v", err)
	}

	page, err := svc.Pull(ctx, uid, wire.PullRequest{Cursor: 0, Limit: 100})
	if err != nil {
		t.Fatalf("pull: %v", err)
	}
	if n := len(page.Changes); n != 2 {
		t.Fatalf("want ready + publish rows only, got %d: %+v", n, page.Changes)
	}
	var data map[string]string
	if err := json.Unmarshal(page.Changes[1].Data, &data); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if data["status"] != "ready" || data["origin"] != "published" || data["audio_key"] != "a/p.mp3" {
		t.Fatalf("publish row must carry the ready state plus origin, got %v", data)
	}
}
