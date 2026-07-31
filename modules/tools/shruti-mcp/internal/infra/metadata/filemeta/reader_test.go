package filemeta_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/metadata/filemeta"
)

const doc = `{
  "title": "Понятие о наслаждении относительно",
  "date": "2006-09-25",
  "languages": ["ru"],
  "author": "Бхакти Вигьяна Госвами",
  "location": "Криница",
  "references": [{"source": "ШБ", "tokens": "2.9.2"}],
  "teaser": "unknown keys are ignored"
}`

type stubFallback struct{ called bool }

func (s *stubFallback) Name() string { return "stub" }
func (s *stubFallback) Extract(context.Context, string, []string) (track.Metadata, error) {
	s.called = true
	return track.NewMetadata(track.MetadataSpec{Title: "from fallback"})
}

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// Both placements resolve, and every field survives the round trip.
func TestExtractBothPlacements(t *testing.T) {
	for _, tc := range []struct{ name, meta string }{
		{"named after the track", "lecture.meta.json"},
		{"one per directory", "meta.json"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := t.TempDir()
			write(t, filepath.Join(in, "d", tc.meta), doc)

			fb := &stubFallback{}
			e := filemeta.Extractor{InDir: in, Fallback: fb}
			md, err := e.Extract(context.Background(), "d/lecture.mp3", nil)
			if err != nil {
				t.Fatalf("extract: %v", err)
			}
			if fb.called {
				t.Error("fallback ran despite a metadata file being present")
			}
			if got := md.Title(); got != "Понятие о наслаждении относительно" {
				t.Errorf("title = %q", got)
			}
			if got := md.AuthorRaw(); got != "Бхакти Вигьяна Госвами" {
				t.Errorf("author = %q", got)
			}
			if got := md.LocationRaw(); got != "Криница" {
				t.Errorf("location = %q", got)
			}
			if d := md.Date(); d == nil || d.Format("2006-01-02") != "2006-09-25" {
				t.Errorf("date = %v", d)
			}
			refs := md.References()
			if len(refs) != 1 || refs[0].SourceCode != "ШБ" || refs[0].Tokens != "2.9.2" {
				t.Errorf("references = %+v", refs)
			}
		})
	}
}

// The per-track placement wins when both exist.
func TestNamedPlacementWins(t *testing.T) {
	in := t.TempDir()
	write(t, filepath.Join(in, "lecture.meta.json"), `{"title":"named"}`)
	write(t, filepath.Join(in, "meta.json"), `{"title":"directory"}`)

	e := filemeta.Extractor{InDir: in}
	md, err := e.Extract(context.Background(), "lecture.mp3", nil)
	if err != nil {
		t.Fatal(err)
	}
	if md.Title() != "named" {
		t.Errorf("title = %q, want the per-track file to win", md.Title())
	}
}

// No metadata file is not an error — the chain continues.
func TestFallsThroughWhenAbsent(t *testing.T) {
	in := t.TempDir()
	fb := &stubFallback{}
	e := filemeta.Extractor{InDir: in, Fallback: fb}

	md, err := e.Extract(context.Background(), "lecture.mp3", nil)
	if err != nil {
		t.Fatal(err)
	}
	if !fb.called {
		t.Error("fallback did not run")
	}
	if md.Title() != "from fallback" {
		t.Errorf("title = %q", md.Title())
	}

	if _, ok, err := e.Read(filepath.Join(in, "lecture.mp3")); ok || err != nil {
		t.Errorf("Read = ok %v, err %v; want absent without error", ok, err)
	}
}

// A file the importer wrote wrong must surface, not silently degrade to the LLM.
func TestMalformedIsAnError(t *testing.T) {
	for _, tc := range []struct{ name, body string }{
		{"not json", `{`},
		{"bad date", `{"title":"x","date":"25.09.2006"}`},
		{"empty title", `{"title":"  "}`},
		{"reference with no source", `{"title":"x","references":[{"tokens":"1.1"}]}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := t.TempDir()
			write(t, filepath.Join(in, "meta.json"), tc.body)

			fb := &stubFallback{}
			e := filemeta.Extractor{InDir: in, Fallback: fb}
			if _, err := e.Extract(context.Background(), "lecture.mp3", nil); err == nil {
				t.Fatal("expected an error")
			}
			if fb.called {
				t.Error("fallback ran — a malformed file must not degrade silently")
			}
		})
	}
}

// Read is what ingest calls to learn the language, by absolute path.
func TestReadByAbsolutePath(t *testing.T) {
	in := t.TempDir()
	write(t, filepath.Join(in, "d", "meta.json"), doc)

	e := filemeta.Extractor{InDir: in}
	md, ok, err := e.Read(filepath.Join(in, "d", "lecture.mp3"))
	if err != nil || !ok {
		t.Fatalf("Read = ok %v, err %v", ok, err)
	}
	langs := md.Languages()
	if len(langs) != 1 || langs[0] != "ru" {
		t.Errorf("languages = %v", langs)
	}
}

// Missing the file entirely is distinct from failing to read it.
func TestUnreadableIsAnError(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root ignores file permissions")
	}
	in := t.TempDir()
	p := filepath.Join(in, "meta.json")
	write(t, p, doc)
	if err := os.Chmod(p, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(p, 0o644) })

	e := filemeta.Extractor{InDir: in}
	_, _, err := e.Read(filepath.Join(in, "lecture.mp3"))
	if err == nil || errors.Is(err, os.ErrNotExist) {
		t.Errorf("err = %v; want a read failure", err)
	}
}
