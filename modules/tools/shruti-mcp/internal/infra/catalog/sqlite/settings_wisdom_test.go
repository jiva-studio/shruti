package sqlitecatalog

import (
	"database/sql"
	"testing"

	_ "github.com/mattn/go-sqlite3"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
)

func newMigratedTestRepo(t *testing.T) (*Repo, func()) {
	t.Helper()
	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	ctx := t.Context()
	// The published schema always ships a `migrations` table; the onboarding
	// migration records its scheme row there. Stand it up for the bare in-memory DB.
	if _, err := db.ExecContext(ctx,
		`CREATE TABLE migrations (name TEXT PRIMARY KEY, scheme INTEGER, applied_at INTEGER)`); err != nil {
		t.Fatalf("create migrations: %v", err)
	}
	// Idempotency: run each ensure twice.
	for i := 0; i < 2; i++ {
		if err := ensureSettingsTable(ctx, db); err != nil {
			t.Fatalf("ensureSettingsTable (pass %d): %v", i, err)
		}
		if err := ensureDailyWisdomTable(ctx, db); err != nil {
			t.Fatalf("ensureDailyWisdomTable (pass %d): %v", i, err)
		}
	}
	return &Repo{db: db, path: ":memory:"}, func() { _ = db.Close() }
}

func TestSettingsRoundTrip(t *testing.T) {
	r, done := newMigratedTestRepo(t)
	defer done()
	ctx := t.Context()

	if _, ok, err := r.GetSetting(ctx, "missing"); err != nil || ok {
		t.Fatalf("missing key: ok=%v err=%v", ok, err)
	}
	if err := r.SetSetting(ctx, "onboarding.topics", `["topic_a","topic_b"]`); err != nil {
		t.Fatalf("set: %v", err)
	}
	v, ok, err := r.GetSetting(ctx, "onboarding.topics")
	if err != nil || !ok {
		t.Fatalf("get: ok=%v err=%v", ok, err)
	}
	if v != `["topic_a","topic_b"]` {
		t.Fatalf("value mismatch: %q", v)
	}
	// upsert overwrites
	if err := r.SetSetting(ctx, "onboarding.topics", `["topic_c"]`); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	v, _, _ = r.GetSetting(ctx, "onboarding.topics")
	if v != `["topic_c"]` {
		t.Fatalf("upsert mismatch: %q", v)
	}
}

func TestListSettingsPrefixEscapesWildcards(t *testing.T) {
	r, done := newMigratedTestRepo(t)
	defer done()
	ctx := t.Context()

	for _, k := range []string{"a_b.one", "axb.two", "a_b.three"} {
		if err := r.SetSetting(ctx, k, "{}"); err != nil {
			t.Fatalf("set %q: %v", k, err)
		}
	}
	// `_` in the prefix must match literally, not as a single-char wildcard,
	// so `axb.two` is excluded.
	got, err := r.ListSettings(ctx, "a_b.")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("want 2 rows for prefix %q, got %d: %+v", "a_b.", len(got), got)
	}
	for _, kv := range got {
		if kv.Key == "axb.two" {
			t.Fatalf("`_` leaked as a wildcard: matched %q", kv.Key)
		}
	}
}

func TestDailyWisdomRoundTrip(t *testing.T) {
	r, done := newMigratedTestRepo(t)
	defer done()
	ctx := t.Context()

	w := catalog.DailyWisdom{
		ID: "wisdom_1", TrackID: "track_a", Language: "en",
		StartMs: 1000, EndMs: 5000, Text: "The soul is eternal.", TopicID: "topic_x",
	}
	if err := r.CreateDailyWisdom(ctx, w); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := r.ListDailyWisdom(ctx, "topic_x", "en", 10)
	if err != nil || len(got) != 1 || got[0].ID != "wisdom_1" {
		t.Fatalf("list: got=%v err=%v", got, err)
	}
	if got[0].CreatedAt == 0 {
		t.Fatalf("created_at not defaulted")
	}
	// topic filter excludes
	if other, _ := r.ListDailyWisdom(ctx, "topic_other", "", 10); len(other) != 0 {
		t.Fatalf("expected no rows for other topic, got %d", len(other))
	}
	if err := r.DeleteDailyWisdom(ctx, "wisdom_1"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if all, _ := r.ListDailyWisdom(ctx, "", "", 0); len(all) != 0 {
		t.Fatalf("expected empty after delete, got %d", len(all))
	}
}
