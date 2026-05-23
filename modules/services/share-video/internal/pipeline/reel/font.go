// Package reel renders the per-frame PNGs that the ffmpeg concat
// demuxer stitches into the text-overlay track, and supplies the
// title-card frame.
//
// The Node service used @napi-rs/canvas with strokeText for the 5px
// black outline around every word. fogleman/gg has no native strokeText;
// we synthesise an outline by drawing the word eight times in black at
// 45°-offset positions, then once in the fill colour on top — the
// "shadow stroke" trick. At 5px / 53px font size the perceptual
// difference is below noticeable on a 720p reel.
package reel

import (
	"fmt"
	"sync"

	"golang.org/x/image/font"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/math/fixed"
)

// FontLoader caches the parsed NotoSans TTF. Faces are NOT cached —
// opentype.Face mutates internal rasterizer state during Glyph() so
// sharing one across goroutines panics. NewFace allocations are cheap
// (~ms), so we make a fresh face per render frame.
type FontLoader struct {
	path string
	once sync.Once
	font *opentype.Font
	err  error
}

func NewFontLoader(path string) *FontLoader {
	return &FontLoader{path: path}
}

func (l *FontLoader) load() (*opentype.Font, error) {
	l.once.Do(func() {
		raw, err := readFile(l.path)
		if err != nil {
			l.err = fmt.Errorf("read font %s: %w", l.path, err)
			return
		}
		ft, err := opentype.Parse(raw)
		if err != nil {
			l.err = fmt.Errorf("parse font %s: %w", l.path, err)
			return
		}
		l.font = ft
	})
	return l.font, l.err
}

// Face constructs a fresh face at the requested size.
// Each render goroutine should call this once and not share the result.
func (l *FontLoader) Face(size int) (font.Face, error) {
	ft, err := l.load()
	if err != nil {
		return nil, err
	}
	face, err := opentype.NewFace(ft, &opentype.FaceOptions{
		Size:    float64(size),
		DPI:     72,
		Hinting: font.HintingFull,
	})
	if err != nil {
		return nil, fmt.Errorf("face %dpt: %w", size, err)
	}
	return face, nil
}

// MeasureString returns the horizontal advance width of s in pixels at
// the given face. Used for both line wrapping and per-word x-walk
// during highlight rendering.
func MeasureString(face font.Face, s string) int {
	var w fixed.Int26_6
	for _, r := range s {
		adv, ok := face.GlyphAdvance(r)
		if !ok {
			continue
		}
		w += adv
	}
	return w.Round()
}

// readFile is split out so tests can swap in a fake FS.
var readFile = func(path string) ([]byte, error) {
	return osReadFile(path)
}
