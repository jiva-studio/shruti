package sqliteregistry

import (
	"path/filepath"
	"testing"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/pipeline"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
)

type fixedMinter struct {
	tail string
	n    int
}

func (m *fixedMinter) MintTail() string {
	m.n++
	if m.tail != "" {
		return m.tail
	}
	// 12 alnum, deterministic per call
	out := []byte("AAAAAAAAAAAA")
	out[len(out)-1] = byte('A' + ((m.n - 1) % 26))
	return string(out)
}

func newTestRegistry(t *testing.T) *Registry {
	t.Helper()
	dir := t.TempDir()
	r, err := New(t.Context(), filepath.Join(dir, "index.db"), &fixedMinter{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { r.Close() })
	return r
}

func TestUpsertFileMintsAndStaysStable(t *testing.T) {
	ctx := t.Context()
	r := newTestRegistry(t)

	src := track.SourceFile{Path: "/tmp/foo.mp3", SHA256: "abc", Size: 100}
	id1, changed, err := r.UpsertFile(ctx, src)
	if err != nil || changed {
		t.Fatalf("first upsert: id=%s changed=%v err=%v", id1, changed, err)
	}
	id2, changed, err := r.UpsertFile(ctx, src)
	if err != nil || changed {
		t.Fatalf("second upsert: changed=%v err=%v", changed, err)
	}
	if id1 != id2 {
		t.Fatalf("trackId not stable: %s vs %s", id1, id2)
	}

	// SHA changes → trackID stable, changed=true
	src2 := src
	src2.SHA256 = "def"
	id3, changed, err := r.UpsertFile(ctx, src2)
	if err != nil || !changed {
		t.Fatalf("sha-change: changed=%v err=%v", changed, err)
	}
	if id3 != id1 {
		t.Fatalf("trackId must stay; got %s want %s", id3, id1)
	}
}

func TestSetStageCascadeReset(t *testing.T) {
	ctx := t.Context()
	r := newTestRegistry(t)

	id, _, err := r.UpsertFile(ctx, track.SourceFile{Path: "/x.mp3", SHA256: "a", Size: 1})
	if err != nil {
		t.Fatal(err)
	}

	// transcribe(ru)=done, review(ru)=done
	must(t, r.SetStage(ctx, id, pipeline.Key{Stage: pipeline.StageTranscribed, Variant: "ru"}, pipeline.StatusDone, nil, ""))
	must(t, r.SetStage(ctx, id, pipeline.Key{Stage: pipeline.StageReviewed, Variant: "ru"}, pipeline.StatusDone, nil, ""))
	// commit(ru) we mark done too; later we'll cascade-clear it
	must(t, r.SetStage(ctx, id, pipeline.Key{Stage: pipeline.StageCommitted, Variant: "ru"}, pipeline.StatusDone, nil, ""))

	// Re-running normalize must reset metadata, transcribe(ru), review(ru), commit(ru) → pending
	must(t, r.SetStage(ctx, id, pipeline.Key{Stage: pipeline.StageNormalized}, pipeline.StatusDone, nil, ""))

	for _, key := range []pipeline.Key{
		{Stage: pipeline.StageTranscribed, Variant: "ru"},
		{Stage: pipeline.StageReviewed, Variant: "ru"},
		{Stage: pipeline.StageCommitted, Variant: "ru"},
		{Stage: pipeline.StageMetadataExtracted},
	} {
		got, ok, err := r.GetStage(ctx, id, key)
		if err != nil || !ok {
			t.Fatalf("expected row for %v, ok=%v err=%v", key, ok, err)
		}
		if got.Status != pipeline.StatusPending {
			t.Errorf("%v: status=%s, want pending", key, got.Status)
		}
	}
}

// `published` is a track-level mark and assetsync skips a marked track
// whole. Committing a language writes new files under public/tracks/<id>/
// (that language's transcript, a re-tagged mp3) and the catalog starts
// advertising them, so the mark has to reopen or the CDN never gets them.
func TestCommitReopensPublishedStage(t *testing.T) {
	ctx := t.Context()
	r := newTestRegistry(t)

	id, _, err := r.UpsertFile(ctx, track.SourceFile{Path: "/y.mp3", SHA256: "b", Size: 1})
	if err != nil {
		t.Fatal(err)
	}

	must(t, r.SetStage(ctx, id, pipeline.Key{Stage: pipeline.StageCommitted, Variant: "ru"}, pipeline.StatusDone, nil, ""))
	must(t, r.SetStage(ctx, id, pipeline.Key{Stage: pipeline.StagePublished}, pipeline.StatusDone, nil, ""))

	// A second language reaches the catalog → its assets are not on the
	// target yet, so the track is no longer published.
	must(t, r.SetStage(ctx, id, pipeline.Key{Stage: pipeline.StageCommitted, Variant: "en"}, pipeline.StatusDone, nil, ""))

	got, ok, err := r.GetStage(ctx, id, pipeline.Key{Stage: pipeline.StagePublished})
	if err != nil || !ok {
		t.Fatalf("published row: ok=%v err=%v", ok, err)
	}
	if got.Status != pipeline.StatusPending {
		t.Errorf("published status=%s, want pending", got.Status)
	}
}

func TestTryClaimStage(t *testing.T) {
	ctx := t.Context()
	r := newTestRegistry(t)

	id, _, _ := r.UpsertFile(ctx, track.SourceFile{Path: "/y.mp3", SHA256: "a", Size: 1})
	key := pipeline.Key{Stage: pipeline.StageNormalized}

	got, err := r.TryClaimStage(ctx, id, key)
	if err != nil || !got {
		t.Fatalf("first claim: ok=%v err=%v", got, err)
	}
	got, err = r.TryClaimStage(ctx, id, key)
	if err != nil {
		t.Fatal(err)
	}
	if got {
		t.Fatal("second claim must refuse — already running")
	}
}

func TestMarkInterruptedAsFailed(t *testing.T) {
	ctx := t.Context()
	r := newTestRegistry(t)

	id, _, _ := r.UpsertFile(ctx, track.SourceFile{Path: "/z.mp3", SHA256: "a", Size: 1})
	key := pipeline.Key{Stage: pipeline.StageNormalized}
	must(t, r.SetStage(ctx, id, key, pipeline.StatusRunning, nil, ""))

	n, err := r.MarkInterruptedAsFailed(ctx)
	if err != nil || n != 1 {
		t.Fatalf("MarkInterruptedAsFailed n=%d err=%v", n, err)
	}
	got, _, _ := r.GetStage(ctx, id, key)
	if got.Status != pipeline.StatusFailed {
		t.Fatalf("status=%s want failed", got.Status)
	}
	if got.Error == "" {
		t.Fatal("expected error message")
	}
}

func TestScanPagination(t *testing.T) {
	ctx := t.Context()
	r := newTestRegistry(t)

	for i := 0; i < 5; i++ {
		path := "/tmp/scan-" + string(rune('a'+i)) + ".mp3"
		_, _, err := r.UpsertFile(ctx, track.SourceFile{Path: path, SHA256: "h", Size: 1})
		if err != nil {
			t.Fatal(err)
		}
	}
	page1, cursor, err := r.Scan(ctx, 2, "")
	if err != nil || len(page1) != 2 {
		t.Fatalf("page1 len=%d err=%v", len(page1), err)
	}
	if cursor == "" {
		t.Fatal("expected cursor")
	}
	page2, _, err := r.Scan(ctx, 100, cursor)
	if err != nil || len(page2) != 3 {
		t.Fatalf("page2 len=%d err=%v", len(page2), err)
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
