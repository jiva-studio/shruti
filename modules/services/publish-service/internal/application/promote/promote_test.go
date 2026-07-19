package promote

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/jiva-studio/shruti/publish/internal/pending"
	"github.com/jiva-studio/shruti/publish/internal/store"
)

type fakeReconciler struct {
	gotIDs   []string
	gotTopic string
	promoted []store.Promoted
	payloads [][]byte
}

func (f *fakeReconciler) PromoteMatching(_ context.Context, ids []string, topic string, mk func(store.Promoted) ([]byte, error)) ([]store.Promoted, error) {
	f.gotIDs, f.gotTopic = ids, topic
	for _, p := range f.promoted {
		b, err := mk(p)
		if err != nil {
			return nil, err
		}
		f.payloads = append(f.payloads, b)
	}
	return f.promoted, nil
}

type fakeCatalog struct{ ids []string }

func (f *fakeCatalog) PublishedTrackIDs(context.Context) ([]string, error) { return f.ids, nil }

type fakeUploader struct {
	key   string
	bytes []byte
}

func (f *fakeUploader) Put(_ context.Context, key string, body []byte, _ string) error {
	f.key, f.bytes = key, body
	return nil
}

// RunOnce reads the catalog, promotes matched tracks with a well-formed
// track.published payload, and rebuilds + uploads pending.db from the remaining
// unpublished rows.
func TestRunOnce(t *testing.T) {
	rec := &fakeReconciler{promoted: []store.Promoted{{TrackID: "t1", OwnerID: "o1"}}}
	cat := &fakeCatalog{ids: []string{"t1", "t2"}}
	up := &fakeUploader{}
	rows := func(context.Context) ([]pending.Row, error) {
		return []pending.Row{{TrackID: "t2", OwnerID: "o2"}}, nil
	}
	p := New(Deps{
		Repo: rec, Catalog: cat, Blob: up, Rows: rows,
		PublishedStream: "track.published", PendingKey: "public/db/pending.db",
	})
	if err := p.RunOnce(context.Background()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if len(rec.gotIDs) != 2 || rec.gotTopic != "track.published" {
		t.Errorf("reconcile args wrong: ids=%v topic=%q", rec.gotIDs, rec.gotTopic)
	}
	if len(rec.payloads) != 1 {
		t.Fatalf("want 1 payload, got %d", len(rec.payloads))
	}
	var ev PublishedEvent
	if err := json.Unmarshal(rec.payloads[0], &ev); err != nil {
		t.Fatalf("payload not valid json: %v", err)
	}
	if ev.Type != "track.published" || ev.TrackID != "t1" || ev.OwnerID != "o1" || ev.UserID != "o1" {
		t.Errorf("payload wrong: %+v", ev)
	}
	if up.key != "public/db/pending.db" || len(up.bytes) == 0 {
		t.Errorf("pending.db not uploaded: key=%q bytes=%d", up.key, len(up.bytes))
	}
}
