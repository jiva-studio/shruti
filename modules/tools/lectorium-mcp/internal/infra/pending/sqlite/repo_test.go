package sqlitepending

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/pending"
)

func openTemp(t *testing.T) *Repo {
	t.Helper()
	path := filepath.Join(t.TempDir(), "pending.db")
	r, err := Open(context.Background(), path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { r.Close() })
	return r
}

func seed(t *testing.T, r *Repo, rows ...pending.Track) {
	t.Helper()
	for _, p := range rows {
		_, err := r.db.Exec(`INSERT INTO pending
			(track_id, owner_id, title_raw, author_raw, location_raw, date_raw,
			 references_raw, lang, transcript_path, audio_path, audio_duration_ms,
			 audio_size_bytes, created_at)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
			p.TrackID, p.OwnerID, p.TitleRaw, p.AuthorRaw, p.LocationRaw, p.DateRaw,
			p.ReferencesRaw, p.Lang, p.TranscriptPath, p.AudioPath, p.AudioDurationMs,
			p.AudioSizeBytes, p.CreatedAt)
		if err != nil {
			t.Fatalf("seed %s: %v", p.TrackID, err)
		}
	}
}

func TestListGetAndMarkConsumed(t *testing.T) {
	ctx := context.Background()
	r := openTemp(t)

	seed(t, r,
		pending.Track{TrackID: "track_a", OwnerID: "user_1", TitleRaw: "A", Lang: "en",
			TranscriptPath: "public/tracks/track_a/transcripts/en.json",
			AudioPath:      "public/tracks/track_a/audio/original.mp3",
			AudioDurationMs: 1000, AudioSizeBytes: 42, CreatedAt: "2026-07-01T00:00:00Z"},
		pending.Track{TrackID: "track_b", OwnerID: "user_2", TitleRaw: "B", Lang: "ru",
			CreatedAt: "2026-07-02T00:00:00Z"},
	)

	// List (unconsumed only by default).
	items, err := r.List(ctx, pending.ListOpts{})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("want 2 pending, got %d", len(items))
	}
	if items[0].TrackID != "track_a" || items[0].AudioSizeBytes != 42 || items[0].AudioDurationMs != 1000 {
		t.Errorf("unexpected first row: %+v", items[0])
	}

	// Get one.
	got, ok, err := r.Get(ctx, "track_a")
	if err != nil || !ok {
		t.Fatalf("get track_a: ok=%v err=%v", ok, err)
	}
	if got.OwnerID != "user_1" || got.TranscriptPath == "" {
		t.Errorf("unexpected get result: %+v", got)
	}

	// Get missing.
	if _, ok, _ := r.Get(ctx, "track_zzz"); ok {
		t.Error("expected track_zzz to be absent")
	}

	// Mark consumed → drops out of the default list, stays with include_consumed.
	marked, err := r.MarkConsumed(ctx, "track_a")
	if err != nil || !marked {
		t.Fatalf("mark consumed: marked=%v err=%v", marked, err)
	}
	items, _ = r.List(ctx, pending.ListOpts{})
	if len(items) != 1 || items[0].TrackID != "track_b" {
		t.Errorf("after consume want only track_b, got %+v", items)
	}
	all, _ := r.List(ctx, pending.ListOpts{IncludeConsumed: true})
	if len(all) != 2 {
		t.Errorf("include_consumed want 2, got %d", len(all))
	}
	consumed, _, _ := r.Get(ctx, "track_a")
	if consumed.ConsumedAt == "" {
		t.Error("track_a should carry consumed_at")
	}

	// Mark consumed on a missing row is a no-op (ok=false).
	if marked, _ := r.MarkConsumed(ctx, "track_zzz"); marked {
		t.Error("mark consumed on missing row should return false")
	}
}

func TestOpenIsIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pending.db")
	ctx := context.Background()
	r1, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("first open: %v", err)
	}
	r1.Close()
	// Re-open the same file: ensurePendingTable must be a no-op.
	r2, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("second open: %v", err)
	}
	defer r2.Close()
	if _, err := r2.List(ctx, pending.ListOpts{}); err != nil {
		t.Fatalf("list after reopen: %v", err)
	}
}
