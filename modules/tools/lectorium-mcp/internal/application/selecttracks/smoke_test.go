//go:build smoke

package selecttracks

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/pipeline"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/ids/nanoid"
	sqliteregistry "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/lakeregistry/sqlite"
)

// TestSelectorFixtureLake exercises the selector against a real lake
// layout: two tracks under outbox/sorted/<lang>/, one off-path mp3 not
// canonicalized, one of the ingested tracks has a transcript.pdf next
// to it under artifacts. Pins the source-mode behaviour and the
// has_pdf / languages / last_done_stage filters end-to-end.
func TestSelectorFixtureLake(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	dir := t.TempDir()
	lakeRoot := filepath.Join(dir, "in")
	outDir := filepath.Join(dir, "out")
	dbPath := filepath.Join(dir, "index.db")

	// Lake fixture: 2 canonical paths + 1 off-path file.
	mustWriteFile(t, filepath.Join(lakeRoot, "outbox/sorted/en/2024-01-01/track1.mp3"), []byte("en-track-1"))
	mustWriteFile(t, filepath.Join(lakeRoot, "outbox/sorted/ru/2024-02-02/track2.mp3"), []byte("ru-track-2"))
	mustWriteFile(t, filepath.Join(lakeRoot, "stray/track3.mp3"), []byte("not-canonical"))

	reg, err := sqliteregistry.New(ctx, dbPath, nanoid.New())
	if err != nil {
		t.Fatalf("open registry: %v", err)
	}
	defer reg.Close()

	id1, _, err := reg.UpsertFile(ctx, track.SourceFile{
		Path:   filepath.Join(lakeRoot, "outbox/sorted/en/2024-01-01/track1.mp3"),
		SHA256: "sha-en", Size: 10, Language: "en",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := reg.UpsertFile(ctx, track.SourceFile{
		Path:   filepath.Join(lakeRoot, "outbox/sorted/ru/2024-02-02/track2.mp3"),
		SHA256: "sha-ru", Size: 10, Language: "ru",
	}); err != nil {
		t.Fatal(err)
	}

	// track1 reaches `transcribed`; track2 reaches `metadata` only.
	for _, st := range []pipeline.Stage{
		pipeline.StageIngested, pipeline.StageNormalized,
		pipeline.StageMetadataExtracted, pipeline.StageTranscribed,
	} {
		key := pipeline.Key{Stage: st}
		if st == pipeline.StageTranscribed {
			key.Variant = "en"
		}
		if err := reg.SetStage(ctx, id1, key, pipeline.StatusDone, nil, ""); err != nil {
			t.Fatal(err)
		}
	}

	// Drop a transcript.pdf next to track1's artifacts so has_pdf:true
	// matches it and only it.
	pdfPath := filepath.Join(outDir, "artifacts", "tracks", string(id1), "transcript.pdf")
	mustWriteFile(t, pdfPath, []byte("%PDF-fake"))

	sel := sqliteregistry.NewTrackSelector(reg.DB(), lakeRoot, outDir, nil)
	uc := UseCase{Selector: sel}

	cases := []struct {
		name string
		in   track.Selector
		min  int
		max  int
	}{
		{"empty selector returns ingested + lake", track.Selector{}, 3, 3},
		{"source=lake returns only the off-path mp3", track.Selector{Source: track.SourceLake}, 1, 1},
		{"source=registry filters out the off-path", track.Selector{Source: track.SourceRegistry}, 2, 2},
		{"languages=[en] hits track1 only", track.Selector{Languages: []string{"en"}}, 1, 1},
		{"has_pdf=true hits track1 only", track.Selector{HasPDF: ptr(true)}, 1, 1},
		{"has_pdf=false hits track2 only", track.Selector{HasPDF: ptr(false)}, 1, 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := uc.Run(ctx, c.in)
			if err != nil {
				t.Fatalf("Run: %v", err)
			}
			n := len(got)
			if n < c.min || n > c.max {
				t.Fatalf("count = %d, want [%d, %d]; rows=%+v", n, c.min, c.max, got)
			}
		})
	}
}

func ptr[T any](v T) *T { return &v }

func mustWriteFile(t *testing.T, path string, body []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, body, 0o644); err != nil {
		t.Fatal(err)
	}
}
