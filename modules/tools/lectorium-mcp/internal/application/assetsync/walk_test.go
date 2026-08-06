package assetsync

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	assetsport "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/assets"
)

func lake(t *testing.T, keys ...string) string {
	t.Helper()
	dir := t.TempDir()
	for _, k := range keys {
		p := filepath.Join(dir, filepath.FromSlash(k))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("body-"+k), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func keysOf(files []assetsport.File) []string {
	out := make([]string, 0, len(files))
	for _, f := range files {
		out = append(out, f.Key)
	}
	sort.Strings(out)
	return out
}

// Artifacts stopped being uploaded as they are written, so the walk is the
// only thing that carries them to the targets now.
func TestWalkCoversPublicAndArtifacts(t *testing.T) {
	dir := lake(t,
		"public/tracks/track_a/audio/original.mp3",
		"public/tracks/track_a/transcripts/ru.json",
		"artifacts/tracks/track_a/transcripts/ru/chunk_0000.json",
		"artifacts/tracks/track_a/transcripts/ru/review.json",
	)
	files, err := UseCase{OutDir: dir}.walk(Options{})
	if err != nil {
		t.Fatal(err)
	}
	got := keysOf(files)
	want := []string{
		"artifacts/tracks/track_a/transcripts/ru/chunk_0000.json",
		"artifacts/tracks/track_a/transcripts/ru/review.json",
		"public/tracks/track_a/audio/original.mp3",
		"public/tracks/track_a/transcripts/ru.json",
	}
	if len(got) != len(want) {
		t.Fatalf("walked %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("key %d = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestWalkToleratesMissingArtifacts(t *testing.T) {
	dir := lake(t, "public/tracks/track_a/audio/original.mp3")
	files, err := UseCase{OutDir: dir}.walk(Options{})
	if err != nil {
		t.Fatalf("a lake with no artifacts must still walk: %v", err)
	}
	if len(files) != 1 {
		t.Errorf("walked %v", keysOf(files))
	}
}

// A missing public/ is a broken lake, not an empty one, so it still errors.
func TestWalkFailsOnMissingPrefix(t *testing.T) {
	dir := lake(t, "public/tracks/track_a/audio/original.mp3")
	if _, err := (UseCase{OutDir: dir}).walk(Options{Prefix: "nowhere"}); err == nil {
		t.Fatal("want an error for a prefix that does not exist")
	}
}

func TestWalkPrefixRestrictsToOneTree(t *testing.T) {
	dir := lake(t,
		"public/tracks/track_a/audio/original.mp3",
		"artifacts/tracks/track_a/transcripts/ru/chunk_0000.json",
	)
	files, err := UseCase{OutDir: dir}.walk(Options{Prefix: "artifacts"})
	if err != nil {
		t.Fatal(err)
	}
	if got := keysOf(files); len(got) != 1 ||
		got[0] != "artifacts/tracks/track_a/transcripts/ru/chunk_0000.json" {
		t.Errorf("walked %v", got)
	}
}

// The track filter has to reach into both trees, or a scoped sync would ship
// a track's audio without its artifacts.
func TestWalkTrackFilterSpansBothTrees(t *testing.T) {
	dir := lake(t,
		"public/tracks/track_a/audio/original.mp3",
		"public/tracks/track_b/audio/original.mp3",
		"artifacts/tracks/track_a/transcripts/ru/chunk_0000.json",
		"artifacts/tracks/track_b/transcripts/ru/chunk_0000.json",
	)
	files, err := UseCase{OutDir: dir}.walk(Options{TrackIds: []string{"track_a"}})
	if err != nil {
		t.Fatal(err)
	}
	got := keysOf(files)
	if len(got) != 2 {
		t.Fatalf("walked %v, want both of track_a's files", got)
	}
	for _, k := range got {
		if !strings.HasPrefix(k, "public/tracks/track_a") &&
			!strings.HasPrefix(k, "artifacts/tracks/track_a") {
			t.Errorf("unexpected key %q", k)
		}
	}
}

func TestWalkSkipsDotFiles(t *testing.T) {
	dir := lake(t,
		"public/tracks/track_a/audio/original.mp3",
		"public/tracks/track_a/.partial.tmp",
	)
	files, err := UseCase{OutDir: dir}.walk(Options{})
	if err != nil {
		t.Fatal(err)
	}
	if got := keysOf(files); len(got) != 1 {
		t.Errorf("walked %v, want the dot file skipped", got)
	}
}
