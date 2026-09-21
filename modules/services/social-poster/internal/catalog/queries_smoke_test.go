package catalog

import (
	"os"
	"testing"

	"github.com/jiva-studio/shruti-social-poster/internal/config"
)

// TestQueriesAgainstLocalDB exercises the real SQL joins against a local
// catalog DB. Point SP_TEST_DB at a current.db to run; skipped otherwise.
func TestQueriesAgainstLocalDB(t *testing.T) {
	path := os.Getenv("SP_TEST_DB")
	if path == "" {
		t.Skip("set SP_TEST_DB to a catalog current.db to run")
	}
	db, err := openRO(t.Context(), path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	c := &Catalog{db: db, version: 1}
	ctx := t.Context()

	w, err := c.Wisdom(ctx, "en", "")
	if err != nil {
		t.Fatalf("Wisdom: %v", err)
	}
	if len(w) == 0 {
		t.Fatal("Wisdom returned 0 candidates")
	}
	first := w[0]
	if first.Kind != config.ContentDailyWisdom || first.ID == "" || first.AudioPath == "" ||
		first.Text == "" || first.EndMs <= first.StartMs {
		t.Fatalf("wisdom candidate malformed: %+v", first)
	}
	t.Logf("wisdom en: %d candidates; sample id=%s author=%q title=%q dur=%dms",
		len(w), first.ID, first.Author, first.Title, first.EndMs-first.StartMs)

	lec, err := c.Lectures(ctx, "en", "07-02", "")
	if err != nil {
		t.Fatalf("Lectures on-this-day: %v", err)
	}
	t.Logf("lectures en on 07-02: %d", len(lec))
	if len(lec) > 0 {
		l := lec[0]
		if l.Kind != config.ContentLecture || l.TrackID == "" || l.AudioPath == "" || l.Date[5:] != "07-02" {
			t.Fatalf("lecture candidate malformed: %+v", l)
		}
		t.Logf("sample lecture: track=%s date=%s title=%q weight=%.3f", l.TrackID, l.Date, l.Title, l.Weight)
	}

	all, err := c.Lectures(ctx, "en", "", "")
	if err != nil {
		t.Fatalf("Lectures all: %v", err)
	}
	if len(all) == 0 {
		t.Fatal("Lectures(all) returned 0")
	}
	t.Logf("lectures en total: %d", len(all))
}
