package sqlitecatalog

import (
	"context"
	"database/sql"
	"testing"

	_ "github.com/mattn/go-sqlite3"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
)

func newTopicsTestRepo(t *testing.T) (*Repo, func()) {
	t.Helper()
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	// ensureTopicsTables is the same path the live binary uses; calling it
	// twice also asserts idempotency.
	for i := 0; i < 2; i++ {
		if err := ensureTopicsTables(context.Background(), db); err != nil {
			t.Fatalf("ensureTopicsTables (pass %d): %v", i, err)
		}
	}
	return &Repo{db: db, path: ":memory:"}, func() { _ = db.Close() }
}

func readTrackTopics(t *testing.T, r *Repo, trackID string) map[string]float64 {
	t.Helper()
	rows, err := r.db.Query(`SELECT topic_id, weight FROM track_topics WHERE track_id = ?`, trackID)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close()
	out := map[string]float64{}
	for rows.Next() {
		var id string
		var w float64
		if err := rows.Scan(&id, &w); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out[id] = w
	}
	return out
}

func TestSetTrackTopicsReplacesFullSet(t *testing.T) {
	r, done := newTopicsTestRepo(t)
	defer done()
	ctx := context.Background()

	if err := r.SetTrackTopics(ctx, "track_a", map[string]float64{
		"topic_x": 0.6, "topic_y": 0.4, "": 0.9, // empty id skipped
	}); err != nil {
		t.Fatalf("first set: %v", err)
	}
	got := readTrackTopics(t, r, "track_a")
	if len(got) != 2 || got["topic_x"] != 0.6 || got["topic_y"] != 0.4 {
		t.Fatalf("after first set: %v", got)
	}

	// Replace: topic_y drops, topic_x reweighted, topic_z added.
	if err := r.SetTrackTopics(ctx, "track_a", map[string]float64{
		"topic_x": 0.2, "topic_z": 0.8,
	}); err != nil {
		t.Fatalf("second set: %v", err)
	}
	got = readTrackTopics(t, r, "track_a")
	if len(got) != 2 || got["topic_x"] != 0.2 || got["topic_z"] != 0.8 {
		t.Fatalf("after replace, expected {topic_x:0.2, topic_z:0.8}, got %v", got)
	}
	if _, ok := got["topic_y"]; ok {
		t.Fatalf("topic_y should have been removed on replace: %v", got)
	}
}

// TestTopicDictRoundTrip verifies the KindTopic dict path resolves to the
// `topics` table (dictTable) and round-trips multilingual names — the generic
// dictcrud path the `topic.create` / `topic.get` tools ride on.
func TestTopicDictRoundTrip(t *testing.T) {
	r, done := newTopicsTestRepo(t)
	defer done()
	ctx := context.Background()

	id, err := r.CreateDict(ctx, catalog.KindTopic, catalog.DictEntry{
		Id:    "topic_test12345",
		Names: map[string]string{"ru": "Карма", "en": "Karma"},
	})
	if err != nil {
		t.Fatalf("CreateDict(topic): %v", err)
	}
	got, ok, err := r.GetDict(ctx, catalog.KindTopic, id)
	if err != nil || !ok {
		t.Fatalf("GetDict(topic): ok=%v err=%v", ok, err)
	}
	if got.Names["ru"] != "Карма" || got.Names["en"] != "Karma" {
		t.Fatalf("topic names round-trip: %v", got.Names)
	}
}

// TestTopicShortNameRoundTrip pins the read/write symmetry for the topic
// short_name column: it is written by the dict CRUD path and must be read
// back by GetDict (the bug was GetDict gating short_name on KindSource only).
func TestTopicShortNameRoundTrip(t *testing.T) {
	r, done := newTopicsTestRepo(t)
	defer done()
	ctx := context.Background()

	id, err := r.CreateDict(ctx, catalog.KindTopic, catalog.DictEntry{
		Id:        "topic_short001",
		Names:     map[string]string{"en": "Bhakti linux-client"},
		ShortName: map[string]string{"en": "Bhakti"},
	})
	if err != nil {
		t.Fatalf("CreateDict(topic): %v", err)
	}
	got, ok, err := r.GetDict(ctx, catalog.KindTopic, id)
	if err != nil || !ok {
		t.Fatalf("GetDict(topic): ok=%v err=%v", ok, err)
	}
	if got.ShortName["en"] != "Bhakti" {
		t.Fatalf("topic short_name not read back: %v", got.ShortName)
	}
}

// TestTopicUsageCountAndDelete pins that the topic kind is wired into the
// usage-count switches. Before the fix UsageCount/usageCountTx had no
// KindTopic case, so topic.get and topic.delete both errored with
// "unknown kind".
func TestTopicUsageCountAndDelete(t *testing.T) {
	r, done := newTopicsTestRepo(t)
	defer done()
	ctx := context.Background()

	id, err := r.CreateDict(ctx, catalog.KindTopic, catalog.DictEntry{
		Id:    "topic_use0001",
		Names: map[string]string{"en": "Karma"},
	})
	if err != nil {
		t.Fatalf("CreateDict(topic): %v", err)
	}

	// No references yet → usage 0, delete allowed... but first attach one.
	if err := r.SetTrackTopics(ctx, "track_u", map[string]float64{id: 0.7}); err != nil {
		t.Fatalf("SetTrackTopics: %v", err)
	}
	n, err := r.UsageCount(ctx, catalog.KindTopic, id)
	if err != nil {
		t.Fatalf("UsageCount(topic): %v", err)
	}
	if n != 1 {
		t.Fatalf("expected usage 1, got %d", n)
	}
	// A referenced topic must refuse deletion.
	if err := r.DeleteDict(ctx, catalog.KindTopic, id); err == nil {
		t.Fatalf("DeleteDict should refuse a referenced topic")
	}

	// Drop the reference, then deletion succeeds.
	if err := r.SetTrackTopics(ctx, "track_u", map[string]float64{}); err != nil {
		t.Fatalf("clear SetTrackTopics: %v", err)
	}
	if err := r.DeleteDict(ctx, catalog.KindTopic, id); err != nil {
		t.Fatalf("DeleteDict(topic) after clearing refs: %v", err)
	}
	if _, ok, _ := r.GetDict(ctx, catalog.KindTopic, id); ok {
		t.Fatalf("topic should be gone after delete")
	}
}

func TestSetTrackTopicsEmptyClears(t *testing.T) {
	r, done := newTopicsTestRepo(t)
	defer done()
	ctx := context.Background()

	if err := r.SetTrackTopics(ctx, "track_b", map[string]float64{"topic_x": 1.0}); err != nil {
		t.Fatalf("set: %v", err)
	}
	if err := r.SetTrackTopics(ctx, "track_b", map[string]float64{}); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if got := readTrackTopics(t, r, "track_b"); len(got) != 0 {
		t.Fatalf("expected empty after clear, got %v", got)
	}
}
