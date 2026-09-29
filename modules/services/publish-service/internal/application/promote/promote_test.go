package promote

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/jiva-studio/shruti/publish/internal/domain"
	"github.com/jiva-studio/shruti/publish/internal/pending"
	"github.com/jiva-studio/shruti/publish/internal/ports"
)

// fakeLedger runs each unit of work against itself and remembers whether it
// was committed or rolled back.
type fakeLedger struct {
	opened     int
	committed  int
	rolledBack int

	gotIDs     []string
	promoted   []domain.Promotion
	enqueueErr error
	topics     []string
	payloads   [][]byte
}

func (f *fakeLedger) WithinTx(_ context.Context, fn func(ports.PromotionTx) error) error {
	f.opened++
	if err := fn(f); err != nil {
		f.rolledBack++
		return err
	}
	f.committed++
	return nil
}

func (f *fakeLedger) MarkPublished(_ context.Context, ids []string) ([]domain.Promotion, error) {
	f.gotIDs = ids
	return f.promoted, nil
}

func (f *fakeLedger) Enqueue(_ context.Context, topic string, payload []byte) error {
	if f.enqueueErr != nil {
		return f.enqueueErr
	}
	f.topics = append(f.topics, topic)
	f.payloads = append(f.payloads, payload)
	return nil
}

type fakeCatalog struct {
	ids []string
	err error
}

func (f *fakeCatalog) PublishedTrackIDs(context.Context) ([]string, error) {
	if f.err != nil {
		return nil, f.err
	}
	return f.ids, nil
}

type fakeUploader struct {
	key   string
	bytes []byte
	puts  int
}

func (f *fakeUploader) Put(_ context.Context, key string, body []byte, _ string) error {
	f.key, f.bytes = key, body
	f.puts++
	return nil
}

func pendingRows(context.Context) ([]pending.Row, error) {
	return []pending.Row{{TrackID: "t2", OwnerID: "o2"}}, nil
}

// RunOnce reads the catalog, promotes matched tracks with a well-formed
// track.published payload in one committed unit of work, and rebuilds +
// uploads pending.db from the remaining unpublished rows.
func TestRunOnce(t *testing.T) {
	led := &fakeLedger{promoted: []domain.Promotion{{TrackID: "t1", OwnerID: "o1"}}}
	cat := &fakeCatalog{ids: []string{"t1", "t2"}}
	up := &fakeUploader{}
	p := New(Deps{
		Ledger: led, Catalog: cat, Blob: up, Rows: pendingRows,
		PublishedStream: "track.published", PendingKey: "public/db/pending.db",
	})
	if err := p.RunOnce(t.Context()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if len(led.gotIDs) != 2 {
		t.Errorf("reconciled ids = %v, want the catalog's two", led.gotIDs)
	}
	if led.opened != 1 || led.committed != 1 {
		t.Errorf("units of work opened=%d committed=%d, want one committed", led.opened, led.committed)
	}
	if len(led.payloads) != 1 || led.topics[0] != "track.published" {
		t.Fatalf("outbox = %d payloads on %v, want 1 on track.published", len(led.payloads), led.topics)
	}
	var ev PublishedEvent
	if err := json.Unmarshal(led.payloads[0], &ev); err != nil {
		t.Fatalf("payload not valid json: %v", err)
	}
	if ev.Type != "track.published" || ev.TrackID != "t1" || ev.OwnerID != "o1" || ev.UserID != "o1" {
		t.Errorf("payload wrong: %+v", ev)
	}
	if up.key != "public/db/pending.db" || len(up.bytes) == 0 {
		t.Errorf("pending.db not uploaded: key=%q bytes=%d", up.key, len(up.bytes))
	}
}

// An announcement that cannot be written takes the flip down with it: the unit
// of work rolls back, the cycle fails, and pending.db is not rebuilt from a
// ledger that did not change.
func TestAnOutboxFailureRollsTheFlipBack(t *testing.T) {
	led := &fakeLedger{
		promoted:   []domain.Promotion{{TrackID: "t1", OwnerID: "o1"}},
		enqueueErr: errors.New("outbox full"),
	}
	up := &fakeUploader{}
	p := New(Deps{
		Ledger: led, Catalog: &fakeCatalog{ids: []string{"t1"}}, Blob: up, Rows: pendingRows,
		PublishedStream: "track.published", PendingKey: "public/db/pending.db",
	})
	err := p.RunOnce(t.Context())
	if err == nil || !strings.Contains(err.Error(), "outbox t1") {
		t.Fatalf("err = %v, want the outbox failure for t1", err)
	}
	if led.rolledBack != 1 || led.committed != 0 {
		t.Errorf("committed=%d rolled back=%d, want the unit of work rolled back", led.committed, led.rolledBack)
	}
	if up.puts != 0 {
		t.Errorf("pending.db uploaded after a failed promotion (puts=%d)", up.puts)
	}
}

// An empty catalog promotes nothing and opens no transaction, but the review
// artifact is still rebuilt.
func TestAnEmptyCatalogOpensNoUnitOfWork(t *testing.T) {
	led := &fakeLedger{}
	up := &fakeUploader{}
	p := New(Deps{
		Ledger: led, Catalog: &fakeCatalog{}, Blob: up, Rows: pendingRows,
		PublishedStream: "track.published", PendingKey: "public/db/pending.db",
	})
	if err := p.RunOnce(t.Context()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if led.opened != 0 {
		t.Errorf("opened %d units of work for an empty catalog", led.opened)
	}
	if up.puts != 1 {
		t.Errorf("pending.db uploaded %d times, want 1", up.puts)
	}
}

// A cycle that promotes nothing still reaches rebuildPending and uploads the
// review artifact.
func TestRunOnceRebuildsPendingWithoutPromotions(t *testing.T) {
	led := &fakeLedger{}
	up := &fakeUploader{}
	rows := func(context.Context) ([]pending.Row, error) {
		return []pending.Row{{TrackID: "t9", OwnerID: "o9"}}, nil
	}
	p := New(Deps{
		Ledger: led, Catalog: &fakeCatalog{ids: []string{"t1"}}, Blob: up, Rows: rows,
		PublishedStream: "track.published", PendingKey: "public/db/pending.db",
	})
	if err := p.RunOnce(t.Context()); err != nil {
		t.Fatalf("RunOnce: %v", err)
	}
	if up.puts != 1 || up.key != "public/db/pending.db" || len(up.bytes) == 0 {
		t.Errorf("pending.db not uploaded: puts=%d key=%q bytes=%d", up.puts, up.key, len(up.bytes))
	}
}

// A failing catalog read aborts the cycle before rebuildPending.
func TestRunOnceCatalogFailureSkipsRebuild(t *testing.T) {
	up := &fakeUploader{}
	rows := func(context.Context) ([]pending.Row, error) {
		return nil, errors.New("rows must not be queried")
	}
	p := New(Deps{
		Ledger: &fakeLedger{}, Catalog: &fakeCatalog{err: errors.New("status 404")},
		Blob: up, Rows: rows,
		PublishedStream: "track.published", PendingKey: "public/db/pending.db",
	})
	err := p.RunOnce(t.Context())
	if err == nil || !strings.Contains(err.Error(), "read catalog") {
		t.Fatalf("err = %v, want a read-catalog failure", err)
	}
	if up.puts != 0 {
		t.Errorf("pending.db uploaded despite a catalog failure (puts=%d)", up.puts)
	}
}
