package integration

import (
	"encoding/json"
	"sync"
	"testing"

	"github.com/google/uuid"

	pullcase "github.com/jiva-studio/shruti/profile/internal/application/pull"
	"github.com/jiva-studio/shruti/profile/internal/domain/hlc"
)

// Lifecycle events, their redeliveries and the publish flip racing on one
// membership still leave a change log whose pulled rows ascend in hlc and end
// on the publish flip carrying the ready state.
func TestConcurrentLifecycleAndPublishConvergeOnFlip(t *testing.T) {
	svc := newService(t, 0)
	ctx := t.Context()
	uid := uuid.New()
	const docID, trackID = "lib-race", "trk-race"

	// ready must be projected before the flip can find the membership.
	ready := json.RawMessage(`{"status":"ready","track_id":"trk-race","audio_key":"a/r.mp3"}`)
	if _, err := svc.ApplyLibraryLifecycle(ctx, uid, docID, "upsert", 0, 3, ready); err != nil {
		t.Fatalf("ready: %v", err)
	}

	late := []struct {
		rank   int
		status string
	}{{1, "queued"}, {2, "processing"}, {3, "ready"}}
	var wg sync.WaitGroup
	errs := make(chan error, 64)
	for range 4 {
		for _, e := range late {
			wg.Go(func() {
				data := json.RawMessage(`{"status":"` + e.status + `","track_id":"trk-race"}`)
				if _, err := svc.ApplyLibraryLifecycle(ctx, uid, docID, "upsert", 0, e.rank, data); err != nil {
					errs <- err
				}
			})
		}
		wg.Go(func() {
			if err := svc.MarkPublished(ctx, uid, trackID); err != nil {
				errs <- err
			}
		})
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent write: %v", err)
	}

	page, err := svc.Pull(ctx, uid, pullcase.Request{Cursor: 0, Limit: 500})
	if err != nil {
		t.Fatalf("pull: %v", err)
	}
	for i := 1; i < len(page.Changes); i++ {
		if page.Changes[i].HLC <= page.Changes[i-1].HLC {
			t.Fatalf("pulled row %s follows %s — a client would step backwards", page.Changes[i].HLC, page.Changes[i-1].HLC)
		}
	}
	last := page.Changes[len(page.Changes)-1]
	if last.HLC != hlc.NewClock().Terminal() {
		t.Fatalf("newest pulled row %s, want the terminal flip", last.HLC)
	}
	var got map[string]string
	if err := json.Unmarshal(last.Data, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got["status"] != "ready" || got["origin"] != "published" || got["audio_key"] != "a/r.mp3" {
		t.Fatalf("flip must carry the ready state plus origin, got %v", got)
	}
}

// A document repaired above the terminal stamp absorbs a redelivered publish
// flip: the flip is not newer than the corrective row, so nothing is appended
// and the corrective state stays the newest pulled row.
func TestRedeliveredFlipAfterRepairWritesNothing(t *testing.T) {
	svc := newService(t, 0)
	ctx := t.Context()
	uid := uuid.New()
	clock := hlc.NewClock()

	next, err := hlc.Successor(clock.Terminal())
	if err != nil {
		t.Fatalf("successor: %v", err)
	}
	repaired := `{"status":"ready","track_id":"trk-rp","origin":"published","audio_key":"a/rp.mp3"}`
	seedRawChange(t, svc, uid, "lib-rp", clock.Ranked(0, 3), `{"status":"ready","track_id":"trk-rp","audio_key":"a/rp.mp3"}`)
	seedRawChange(t, svc, uid, "lib-rp", clock.Terminal(), `{"status":"processing","track_id":"trk-rp","origin":"published"}`)
	seedRawChange(t, svc, uid, "lib-rp", next, repaired)
	if _, err := svc.Pool.Exec(ctx,
		`INSERT INTO profile.library_items (user_id, doc_id, track_id, status, audio_key, origin)
		 VALUES ($1, 'lib-rp', 'trk-rp', 'ready', 'a/rp.mp3', 'published')`, uid); err != nil {
		t.Fatalf("seed projection: %v", err)
	}

	if err := svc.MarkPublished(ctx, uid, "trk-rp"); err != nil {
		t.Fatalf("mark published: %v", err)
	}
	if _, err := svc.ApplyLibraryLifecycle(ctx, uid, "lib-rp", "upsert", 5, 3, json.RawMessage(`{"status":"failed","track_id":"trk-rp"}`)); err != nil {
		t.Fatalf("later generation: %v", err)
	}

	page, err := svc.Pull(ctx, uid, pullcase.Request{Cursor: 0, Limit: 100})
	if err != nil {
		t.Fatalf("pull: %v", err)
	}
	if n := len(page.Changes); n != 3 {
		t.Fatalf("want the 3 seeded rows only, got %d", n)
	}
	if last := page.Changes[2]; last.HLC != next {
		t.Fatalf("newest pulled row %s, want the corrective row %s", last.HLC, next)
	}
}

// ready and failed share a rank, so within one generation the second of them
// ties the master's stamp: it is dropped from both the change log and the
// projection, which therefore never disagree.
func TestSameStampDifferentStateLeavesLogAndProjectionAgreeing(t *testing.T) {
	svc := newService(t, 0)
	ctx := t.Context()
	uid := uuid.New()

	if _, err := svc.ApplyLibraryLifecycle(ctx, uid, "lib-tie", "upsert", 0, 3, json.RawMessage(`{"status":"ready","track_id":"trk-tie"}`)); err != nil {
		t.Fatalf("ready: %v", err)
	}
	if _, err := svc.ApplyLibraryLifecycle(ctx, uid, "lib-tie", "upsert", 0, 3, json.RawMessage(`{"status":"failed","track_id":"trk-tie"}`)); err != nil {
		t.Fatalf("failed: %v", err)
	}
	var status string
	if err := svc.Pool.QueryRow(ctx,
		`SELECT status FROM profile.library_items WHERE user_id=$1 AND doc_id='lib-tie'`, uid,
	).Scan(&status); err != nil {
		t.Fatalf("projection: %v", err)
	}
	page, err := svc.Pull(ctx, uid, pullcase.Request{Cursor: 0, Limit: 100})
	if err != nil {
		t.Fatalf("pull: %v", err)
	}
	var pulled map[string]string
	if err := json.Unmarshal(page.Changes[len(page.Changes)-1].Data, &pulled); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if status != "ready" || pulled["status"] != "ready" {
		t.Fatalf("projection %q and newest pulled %q must both stay ready", status, pulled["status"])
	}
}
