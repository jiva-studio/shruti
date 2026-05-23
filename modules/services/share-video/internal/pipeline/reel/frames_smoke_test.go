package reel

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/akdasa-studios/lectorium-share-video/internal/types"
)

// Smoke: render a real frame from the bundled font and verify the PNG
// is well-formed and non-trivially sized. Doesn't pixel-diff (visual
// parity validated by manual review), just checks the pipeline runs
// end-to-end without panicking.
func TestRender_WordFrameSmoke(t *testing.T) {
	wd, _ := os.Getwd()
	fontPath := filepath.Join(wd, "..", "..", "..", "assets", "fonts", "NotoSans-Bold.ttf")
	if _, err := os.Stat(fontPath); err != nil {
		t.Skipf("font not at %s — run from share-video module root", fontPath)
	}

	tmp := t.TempDir()
	r := &Renderer{Fonts: NewFontLoader(fontPath)}
	slide := types.Slide{
		Text:      "Привет мир Hello world",
		StartTime: 0,
		Duration:  2,
		Words: []types.WordTiming{
			{Word: "Привет", Start: 0, End: 0.4},
			{Word: "мир", Start: 0.4, End: 0.8},
			{Word: "Hello", Start: 0.8, End: 1.4},
			{Word: "world", Start: 1.4, End: 2.0},
		},
	}
	frames, err := r.GenerateWordFrames(slide, 0, tmp)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if len(frames) != 4 {
		t.Fatalf("want 4 frames, got %d", len(frames))
	}
	for _, f := range frames {
		info, err := os.Stat(f.Path)
		if err != nil {
			t.Fatalf("frame %s: %v", f.Path, err)
		}
		if info.Size() < 1000 {
			t.Errorf("frame %s suspiciously small: %d bytes", f.Path, info.Size())
		}
	}
}
