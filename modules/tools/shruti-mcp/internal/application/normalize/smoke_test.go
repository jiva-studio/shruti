//go:build smoke

package normalize_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/ingest"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/normalize"
	fsaudio "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/audiostore/fs"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/ids/nanoid"
	sqliteregistry "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/lakeregistry/sqlite"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/loudness/ffmpeg"
	audioport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/audio"
)

// TestIngestThenNormalize ingests /tmp/lake/in/test.mp3 and verifies that the
// canonical original.mp3 lands at out/public/.../original.mp3 with mp3 codec.
//
// Run with: go test -tags=smoke ./internal/application/normalize/...
func TestIngestThenNormalize(t *testing.T) {
	srcMP3 := os.Getenv("SHRUTI_SMOKE_MP3")
	if srcMP3 == "" {
		srcMP3 = "/tmp/lake/in/test.mp3"
	}
	if _, err := os.Stat(srcMP3); err != nil {
		t.Skipf("source mp3 missing: %v", err)
	}
	outDir := t.TempDir()

	ctx := context.Background()

	registry, err := sqliteregistry.New(ctx, filepath.Join(outDir, "artifacts", "lake", "index.db"), nanoid.New())
	if err != nil {
		t.Fatal(err)
	}
	defer registry.Close()

	audio := fsaudio.New(outDir)
	ff := ffmpeg.New("ffmpeg")

	ingestUC := ingest.UseCase{Registry: registry, Audio: audio}
	res, err := ingestUC.Run(ctx, srcMP3)
	if err != nil {
		t.Fatalf("ingest: %v", err)
	}
	if _, err := os.Stat(audio.SourceArtifactPath(res.TrackId)); err != nil {
		t.Fatalf("source artifact missing: %v", err)
	}

	normUC := normalize.UseCase{
		Registry:   registry,
		Audio:      audio,
		Normalizer: ff,
	}
	if err := normUC.Run(ctx, res.TrackId); err != nil {
		t.Fatalf("normalize: %v", err)
	}

	canonical := audio.PublicAudioPath(res.TrackId, audioport.VersionOriginal)
	stat, err := os.Stat(canonical)
	if err != nil {
		t.Fatalf("canonical missing: %v", err)
	}
	if stat.Size() == 0 {
		t.Fatal("canonical empty")
	}
	probe, err := ff.Probe(ctx, canonical)
	if err != nil {
		t.Fatalf("probe canonical: %v", err)
	}
	if probe.DurationMs < 2500 || probe.DurationMs > 4000 {
		t.Errorf("canonical duration ~3s expected, got %dms", probe.DurationMs)
	}
	if probe.Bitrate < 100 || probe.Bitrate > 160 {
		t.Errorf("canonical bitrate ~128 expected, got %d kbps", probe.Bitrate)
	}
	if probe.Channels != 2 {
		t.Errorf("source was stereo, canonical channels=%d (expected 2)", probe.Channels)
	}
}
