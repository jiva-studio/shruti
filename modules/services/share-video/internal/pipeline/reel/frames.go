package reel

import (
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/fogleman/gg"
	"golang.org/x/image/draw"
	"golang.org/x/image/font"

	"github.com/jiva-studio/lectorium-share-video/internal/types"
)

const (
	// Mirror DEFAULTS from ReelGenerator.ts.
	defaultSlideWidth  = 720
	defaultSlideHeight = 1280
	defaultFontSize    = 53
	maxLineRatio       = 0.85 // 85% of slide width

	// Visual signature: 5px-wide black outline around every word so the
	// caller's text reads on a busy video background.
	strokeWidth = 5

	// Title-card colours from ReelGenerator.ts:TITLE_BG_COLOR / TITLE_TEXT_COLOR.
	titleBg   = "#F5EBDC"
	titleText = "#2A2A2A"

	wordHighlightColor = "#FFD700" // gold
)

// Options collects the knobs ReelGeneratorOptions exposed in TS. Zero
// values map to the defaults; pass non-zero to override.
type Options struct {
	SlideWidth  int
	SlideHeight int
	FontSize    int
}

func (o Options) effective() Options {
	if o.SlideWidth == 0 {
		o.SlideWidth = defaultSlideWidth
	}
	if o.SlideHeight == 0 {
		o.SlideHeight = defaultSlideHeight
	}
	if o.FontSize == 0 {
		o.FontSize = defaultFontSize
	}
	return o
}

// FrameSpec describes a single PNG the ffmpeg concat-demuxer will play
// for `Duration` seconds starting at `StartTime`.
type FrameSpec struct {
	Path      string
	Duration  float64
	StartTime float64
}

// Renderer holds the font and the rendering parameters shared across
// frames in a render job.
type Renderer struct {
	Fonts   *FontLoader
	Opts    Options
	IconPNG string // path to title-card icon; "" disables title rendering
}

// GenerateWordFrames produces one PNG per word in `slide.Words`, each
// frame highlighting the current word in gold. If a slide has no word
// timings we emit a single PNG covering its full duration.
//
// Each goroutine constructs its own font.Face because opentype.Face
// mutates rasterizer state during Glyph() — sharing one panics under
// concurrency.
func (r *Renderer) GenerateWordFrames(slide types.Slide, slideIndex int, tempDir string) ([]FrameSpec, error) {
	opts := r.Opts.effective()
	if err := os.MkdirAll(tempDir, 0o755); err != nil {
		return nil, fmt.Errorf("mkdir %s: %w", tempDir, err)
	}

	if len(slide.Words) == 0 {
		face, err := r.Fonts.Face(opts.FontSize)
		if err != nil {
			return nil, err
		}
		path := filepath.Join(tempDir, fmt.Sprintf("slide_%03d.png", slideIndex))
		if err := r.drawSingleFrame(path, face, opts, slide.Text, -1, nil); err != nil {
			return nil, err
		}
		return []FrameSpec{{Path: path, Duration: slide.Duration, StartTime: slide.StartTime}}, nil
	}

	specs := make([]FrameSpec, len(slide.Words))
	errs := make([]error, len(slide.Words))
	var wg sync.WaitGroup
	for i := range slide.Words {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			face, err := r.Fonts.Face(opts.FontSize)
			if err != nil {
				errs[i] = err
				return
			}
			path := filepath.Join(tempDir, fmt.Sprintf("slide_%03d_word_%03d.png", slideIndex, i))
			if err := r.drawSingleFrame(path, face, opts, slide.Text, i, slide.Words); err != nil {
				errs[i] = err
				return
			}
			specs[i] = FrameSpec{
				Path:      path,
				Duration:  slide.Words[i].End - slide.Words[i].Start,
				StartTime: slide.Words[i].Start,
			}
		}(i)
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			return nil, err
		}
	}
	return specs, nil
}

// drawSingleFrame renders one PNG. highlightWord < 0 means "no
// highlight" — used for single-frame slides and for the leading title
// card.
func (r *Renderer) drawSingleFrame(outPath string, face font.Face, opts Options, text string, highlightWord int, words []types.WordTiming) error {
	dc := gg.NewContext(opts.SlideWidth, opts.SlideHeight)
	dc.SetFontFace(face)

	maxTextWidth := int(float64(opts.SlideWidth) * maxLineRatio)
	lines := wrapText(face, text, maxTextWidth)

	lineHeight := float64(opts.FontSize) * 1.2
	totalHeight := float64(len(lines)) * lineHeight
	startY := float64(opts.SlideHeight)*0.75 - totalHeight/2

	// Translucent plate behind the text. Scaled from the 1080p reference
	// (40/30/8) by 720/1080 = 2/3 — keeps proportional layout.
	padding := 27.0
	bgWidth := float64(maxTextWidth) + padding*2
	bgHeight := totalHeight + padding*1.5
	bgX := (float64(opts.SlideWidth) - bgWidth) / 2
	bgY := startY - padding*0.75
	cornerRadius := 20.0

	dc.SetRGBA(0, 0, 0, 0.1)
	dc.DrawRoundedRectangle(bgX, bgY, bgWidth, bgHeight, cornerRadius)
	dc.Fill()

	centerX := float64(opts.SlideWidth) / 2
	for lineIdx, line := range lines {
		baselineY := startY + (float64(lineIdx)+0.5)*lineHeight

		if highlightWord >= 0 && words != nil {
			// Per-word x-walk for highlighting. textAlign='left' on the
			// canvas; we compute the line's total width once, then walk.
			wordIdxStart := wordsBefore(lines[:lineIdx])
			lineWidth := float64(MeasureString(face, line))
			currentX := centerX - lineWidth/2
			spaceWidth := float64(MeasureString(face, " "))

			lineWords := strings.Fields(line)
			for i, w := range lineWords {
				wordIdx := wordIdxStart + i
				fill := "#FFFFFF"
				if wordIdx == highlightWord {
					fill = wordHighlightColor
				}
				drawTextWithStroke(dc, w, currentX, baselineY, fill)
				currentX += float64(MeasureString(face, w)) + spaceWidth
			}
		} else {
			// Single-frame slide: centered line.
			lineWidth := float64(MeasureString(face, line))
			drawTextWithStroke(dc, line, centerX-lineWidth/2, baselineY, "#FFFFFF")
		}
	}

	return savePNG(outPath, dc.Image())
}

// drawTextWithStroke renders `text` at the (left, baseline) position
// with a 5px black outline and the given fill colour on top. The
// outline is synthesised with eight offsets ‑ enough fidelity for the
// 53px font at 720p; @napi-rs/canvas's true strokeText would be the
// reference, but the perceived difference at this scale is negligible.
func drawTextWithStroke(dc *gg.Context, text string, x, y float64, fillHex string) {
	// 8-offset shadow. r is the stroke half-width; the diagonal offsets
	// approximate a round pen.
	r := float64(strokeWidth)
	offsets := [][2]float64{
		{-r, 0}, {r, 0}, {0, -r}, {0, r},
		{-r * 0.707, -r * 0.707}, {r * 0.707, -r * 0.707},
		{-r * 0.707, r * 0.707}, {r * 0.707, r * 0.707},
	}
	dc.SetHexColor("#000000")
	for _, o := range offsets {
		dc.DrawString(text, x+o[0], y+o[1])
	}
	dc.SetHexColor(fillHex)
	dc.DrawString(text, x, y)
}

// wrapText is the Go port of videoGenerator.ts:wrapText. Greedy: pack
// words into a line until the next one would exceed maxWidth, then
// emit and start over.
func wrapText(face font.Face, text string, maxWidth int) []string {
	words := strings.Fields(text)
	var lines []string
	current := ""
	for _, w := range words {
		test := w
		if current != "" {
			test = current + " " + w
		}
		if MeasureString(face, test) > maxWidth && current != "" {
			lines = append(lines, current)
			current = w
		} else {
			current = test
		}
	}
	if current != "" {
		lines = append(lines, current)
	}
	if len(lines) == 0 {
		return []string{text}
	}
	return lines
}

// wordsBefore counts how many words are in `prevLines`, so per-word
// highlight indexing knows where each line starts in the flat list.
func wordsBefore(prevLines []string) int {
	n := 0
	for _, line := range prevLines {
		n += len(strings.Fields(line))
	}
	return n
}

// GenerateTitleFrame renders the cream title-card frame: icon + title
// text stacked and vertically centered. Uses a smaller font (90% of
// body size) and dark text on cream bg.
func (r *Renderer) GenerateTitleFrame(title, outPath string) error {
	opts := r.Opts.effective()
	titleFontSize := int(math.Round(float64(opts.FontSize) * 0.9))
	face, err := r.Fonts.Face(titleFontSize)
	if err != nil {
		return err
	}
	dc := gg.NewContext(opts.SlideWidth, opts.SlideHeight)
	dc.SetFontFace(face)

	dc.SetHexColor(titleBg)
	dc.DrawRectangle(0, 0, float64(opts.SlideWidth), float64(opts.SlideHeight))
	dc.Fill()

	maxTextWidth := int(float64(opts.SlideWidth) * maxLineRatio)
	lines := wrapText(face, title, maxTextWidth)
	lineHeight := float64(titleFontSize) * 1.25
	totalTextHeight := float64(len(lines)) * lineHeight

	iconSize := int(math.Round(float64(opts.SlideWidth) * 0.35))
	iconTitleGap := int(math.Round(float64(opts.SlideHeight) * 0.047))
	groupHeight := float64(iconSize+iconTitleGap) + totalTextHeight
	iconX := (opts.SlideWidth - iconSize) / 2
	iconY := int(math.Round((float64(opts.SlideHeight) - groupHeight) / 2))

	if r.IconPNG != "" {
		if img, err := loadPNG(r.IconPNG); err == nil {
			scaled := image.NewRGBA(image.Rect(0, 0, iconSize, iconSize))
			draw.CatmullRom.Scale(scaled, scaled.Bounds(), img, img.Bounds(), draw.Over, nil)
			dc.DrawImage(scaled, iconX, iconY)
		}
		// If load fails we silently render without the icon — same
		// "ignore" semantics as videoGenerator.ts:325-327.
	}

	dc.SetHexColor(titleText)
	titleStartY := float64(iconY+iconSize+iconTitleGap)
	for i, line := range lines {
		baselineY := titleStartY + (float64(i)+0.5)*lineHeight
		lineWidth := float64(MeasureString(face, line))
		dc.DrawString(line, float64(opts.SlideWidth)/2-lineWidth/2, baselineY)
	}

	return savePNG(outPath, dc.Image())
}

// savePNG encodes a draw.Image to disk as a PNG.
func savePNG(path string, img image.Image) error {
	f, err := os.Create(path)
	if err != nil {
		return fmt.Errorf("create %s: %w", path, err)
	}
	defer f.Close()
	return png.Encode(f, img)
}

func loadPNG(path string) (image.Image, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	img, err := png.Decode(f)
	if err != nil {
		return nil, err
	}
	return img, nil
}

// Compile-time sanity: gg uses image.Image — we're aligned.
var _ color.Color = color.White
