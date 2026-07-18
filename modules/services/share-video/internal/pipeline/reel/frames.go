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

	"github.com/jiva-studio/shruti-share-video/internal/types"
)

const (
	// Mirror DEFAULTS from ReelGenerator.ts.
	defaultSlideWidth  = 720
	defaultSlideHeight = 1280
	defaultFontSize    = 53
	maxLineRatio       = 0.85 // 85% of slide width
	// A caption never wraps past this many lines: a 4th line pushes the
	// transcript plate down onto the brand watermark. The slide packer
	// (PackSlides) flushes a slide before a word would spill a 4th line.
	maxCaptionLines = 3
	// MaxCaptionLines is the exported cap for callers (see PackSlides).
	MaxCaptionLines = maxCaptionLines

	// Visual signature: 5px-wide black outline around every word so the
	// caller's text reads on a busy video background.
	strokeWidth = 5

	// Title-card colours from ReelGenerator.ts:TITLE_BG_COLOR / TITLE_TEXT_COLOR.
	titleBg   = "#F5EBDC"
	titleText = "#2A2A2A"

	wordHighlightColor = "#FFD700" // gold

	// Persistent-overlay layout. Header sits near the top, the shloka in
	// the vertical middle; the transcript body keeps its 0.75 anchor
	// (drawSingleFrame) so the three zones don't collide.
	headerFontSize  = 46
	headerSubSize   = 30
	shlokaIASTSize  = 42
	shlokaTransSize = 34
	headerTopRatio  = 0.06 // top of the header block, fraction of height
	shlokaMidRatio  = 0.42 // vertical center of the shloka block
	// Plate behind overlay text — darker than the transcript's 0.1 so the
	// hook reads over any background clip.
	overlayPlateAlpha = 0.38
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

// Overlay is the persistent composition drawn on top of every frame: a
// header hook near the top and a shloka block in the middle. Both zones
// stay identical for the whole clip; nil fields are skipped. Passing a
// nil *Overlay reproduces the legacy caption-only reel.
type Overlay struct {
	Header *HeaderText
	Center *ShlokaText
	Brand  *BrandMark
}

// HeaderText is the top hook: a headline plus an optional second line.
type HeaderText struct {
	Text string
	Sub  string
}

// ShlokaText is the center card: transliteration line(s) + translation.
type ShlokaText struct {
	IAST        string
	Translation string
}

// BrandMark is the persistent watermark. Position is "under_header"
// (centered just below the header band) or "corner" (top-right).
type BrandMark struct {
	Text     string
	Position string
}

func (o *Overlay) empty() bool {
	return o == nil || (o.Header == nil && o.Center == nil && o.Brand == nil)
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
func (r *Renderer) GenerateWordFrames(slide types.Slide, slideIndex int, tempDir string, overlay *Overlay) ([]FrameSpec, error) {
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
		if err := r.drawSingleFrame(path, face, opts, slide.Text, -1, nil, overlay); err != nil {
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
			if err := r.drawSingleFrame(path, face, opts, slide.Text, i, slide.Words, overlay); err != nil {
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

// PackSlides groups aligned word timings into caption slides, flushing a
// slide before a word would make the caption wrap past maxCaptionLines.
// Unlike align.WordsToSlides (which caps by character count and can still
// spill a 4th line for wide words), this measures real wrapped lines with
// the caption face, so a slide never overlaps the brand watermark below it.
func (r *Renderer) PackSlides(words []types.WordTiming, maxLines int) ([]types.Slide, error) {
	if len(words) == 0 {
		return nil, nil
	}
	if maxLines <= 0 {
		maxLines = maxCaptionLines
	}
	opts := r.Opts.effective()
	face, err := r.Fonts.Face(opts.FontSize)
	if err != nil {
		return nil, err
	}
	maxTextWidth := int(float64(opts.SlideWidth) * maxLineRatio)

	var slides []types.Slide
	var buf []types.WordTiming
	parts := make([]string, 0, 16)

	flush := func() {
		if len(buf) == 0 {
			return
		}
		start := buf[0].Start
		dur := buf[len(buf)-1].End - start
		if dur < 0.001 {
			dur = 0.001
		}
		ws := append([]types.WordTiming(nil), buf...)
		slides = append(slides, types.Slide{
			Text:      strings.Join(parts, " "),
			StartTime: start,
			Duration:  dur,
			Words:     ws,
		})
		buf = buf[:0]
		parts = parts[:0]
	}

	for _, w := range words {
		cand := append(append([]string(nil), parts...), w.Word)
		if len(buf) > 0 && len(wrapText(face, strings.Join(cand, " "), maxTextWidth)) > maxLines {
			flush()
		}
		buf = append(buf, w)
		parts = append(parts, w.Word)
	}
	flush()
	return slides, nil
}

// drawSingleFrame renders one PNG. highlightWord < 0 means "no
// highlight" — used for single-frame slides and for the leading title
// card. When overlay is non-nil its persistent zones (header, center
// shloka) are painted first, then the transcript caption on top.
func (r *Renderer) drawSingleFrame(outPath string, face font.Face, opts Options, text string, highlightWord int, words []types.WordTiming, overlay *Overlay) error {
	dc := gg.NewContext(opts.SlideWidth, opts.SlideHeight)

	// Persistent overlay behind the caption. Uses its own faces/sizes.
	if !overlay.empty() {
		if err := r.drawOverlay(dc, opts, overlay); err != nil {
			return err
		}
	}

	// No transcript text on this frame (transcript section disabled and
	// the caller drives only the overlay) — nothing more to draw.
	if strings.TrimSpace(text) == "" {
		return savePNG(outPath, dc.Image())
	}

	maxTextWidth := int(float64(opts.SlideWidth) * maxLineRatio)
	lines := wrapText(face, text, maxTextWidth)

	// Lay the caption out with real font metrics and vertically center its
	// ink on 68% of the slide height (raised from 0.75 so the caption and the
	// brand watermark below it clear the YouTube Shorts bottom UI), then hug a
	// plate around it — same treatment as the header/overlay blocks.
	placed, inkH, maxW := layoutBlock([]textSeg{{face: face, lines: lines}})
	inkTop := float64(opts.SlideHeight)*0.68 - inkH/2

	padding := 27.0
	plateW := maxW + padding*2
	if plateW > float64(opts.SlideWidth) {
		plateW = float64(opts.SlideWidth)
	}
	plateX := (float64(opts.SlideWidth) - plateW) / 2
	plateY := inkTop - padding
	plateH := inkH + padding*2
	dc.SetRGBA(0, 0, 0, 0.1)
	dc.DrawRoundedRectangle(plateX, plateY, plateW, plateH, 20)
	dc.Fill()

	dc.SetFontFace(face)
	centerX := float64(opts.SlideWidth) / 2
	for lineIdx, pl := range placed {
		baselineY := inkTop + pl.baseline
		line := pl.text

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

// textSeg is one styled run inside an overlay block: pre-wrapped lines
// sharing one face.
type textSeg struct {
	face  font.Face
	lines []string
}

// lineLead is the baseline-to-baseline spacing as a factor of the face's
// (ascent+descent). 1.0 packs lines tight — Noto's metric ascent already
// carries enough headroom that IAST accents/dots don't collide.
const lineLead = 1.0

// faceVMetrics returns a face's ascent and descent in pixels.
func faceVMetrics(f font.Face) (ascent, descent float64) {
	m := f.Metrics()
	return float64(m.Ascent) / 64, float64(m.Descent) / 64
}

// placedLine is one laid-out line with its baseline measured from the
// block's ink-top (y=0).
type placedLine struct {
	face     font.Face
	text     string
	baseline float64
}

// layoutBlock stacks segs' lines top-down from ink-top 0 using real font
// metrics, so each line occupies only its ascent+descent — not an
// inflated 1.25·size box that left extra space at the bottom. Returns the
// placed lines, total ink height (top of first cap → bottom of last
// descent), and the widest line.
func layoutBlock(segs []textSeg) (lines []placedLine, inkHeight, maxWidth float64) {
	cursor := 0.0
	for _, s := range segs {
		a, d := faceVMetrics(s.face)
		adv := (a + d) * lineLead
		for _, t := range s.lines {
			baseline := cursor + a
			lines = append(lines, placedLine{face: s.face, text: t, baseline: baseline})
			inkHeight = baseline + d
			cursor += adv
			if w := float64(MeasureString(s.face, t)); w > maxWidth {
				maxWidth = w
			}
		}
	}
	return lines, inkHeight, maxWidth
}

// blockHeight is the metric ink height of a block — used to vertically
// center a block on an anchor.
func blockHeight(segs []textSeg) float64 {
	_, h, _ := layoutBlock(segs)
	return h
}

// drawBlock paints a stacked, centered, stroked white text block over a
// translucent rounded plate that hugs the real glyph ink with equal
// padding on every side. topY is the ink-top of the block. Returns the
// plate's bottom Y (so a watermark can sit just below it).
func drawBlock(dc *gg.Context, opts Options, segs []textSeg, topY float64) float64 {
	if len(segs) == 0 {
		return topY
	}
	lines, inkH, maxW := layoutBlock(segs)

	pad := 26.0
	plateW := maxW + pad*2
	if plateW > float64(opts.SlideWidth) {
		plateW = float64(opts.SlideWidth)
	}
	plateX := (float64(opts.SlideWidth) - plateW) / 2
	plateY := topY - pad
	plateH := inkH + pad*2
	dc.SetRGBA(0, 0, 0, overlayPlateAlpha)
	dc.DrawRoundedRectangle(plateX, plateY, plateW, plateH, 20)
	dc.Fill()

	centerX := float64(opts.SlideWidth) / 2
	for _, pl := range lines {
		dc.SetFontFace(pl.face)
		lineW := float64(MeasureString(pl.face, pl.text))
		drawTextWithStroke(dc, pl.text, centerX-lineW/2, topY+pl.baseline, "#FFFFFF")
	}
	return plateY + plateH
}

// brandFontSize / brandAlpha tune the watermark — small and semi-opaque
// so it reads as a signature, not a caption.
const (
	brandFontSize = 30
	brandAlpha    = 0.9
)

// drawBrand paints the persistent watermark: the app logo (icon.png) plus
// the wordmark, as a horizontal lockup. Positions:
//   - "under_header": centered just below the header band
//   - "bottom":       centered near the bottom, under the transcript
//   - "corner":       pinned to the top-right
func (r *Renderer) drawBrand(dc *gg.Context, opts Options, b *BrandMark, headerBottom float64) error {
	face, err := r.Fonts.Face(brandFontSize)
	if err != nil {
		return err
	}
	dc.SetFontFace(face)
	tw := float64(MeasureString(face, b.Text))
	a, d := faceVMetrics(face)

	iconH := float64(brandFontSize) * 1.6
	gap := 12.0

	var iconImg image.Image
	if r.IconPNG != "" {
		if img, err := loadPNG(r.IconPNG); err == nil {
			iconImg = img
		}
	}
	totalW := tw
	if iconImg != nil {
		totalW = iconH + gap + tw
	}
	rowH := a + d
	if iconImg != nil && iconH > rowH {
		rowH = iconH
	}

	W := float64(opts.SlideWidth)
	H := float64(opts.SlideHeight)
	pad := 22.0
	var startX, rowTop float64
	switch b.Position {
	case "corner":
		startX = W - pad - totalW
		rowTop = pad
	case "bottom":
		startX = (W - totalW) / 2
		rowTop = H*0.82 - rowH
	default: // under_header
		startX = (W - totalW) / 2
		rowTop = headerBottom + 20
	}

	textX := startX
	if iconImg != nil {
		sz := int(iconH)
		scaled := image.NewRGBA(image.Rect(0, 0, sz, sz))
		draw.CatmullRom.Scale(scaled, scaled.Bounds(), iconImg, iconImg.Bounds(), draw.Over, nil)
		dc.DrawImage(scaled, int(startX), int(rowTop+(rowH-iconH)/2))
		textX = startX + iconH + gap
	}

	// Text baseline: vertically centered within the row.
	baseline := rowTop + (rowH+a-d)/2

	// Semi-opaque white with a soft dark stroke for legibility on any clip.
	rs := 3.0
	offsets := [][2]float64{
		{-rs, 0}, {rs, 0}, {0, -rs}, {0, rs},
		{-rs * 0.707, -rs * 0.707}, {rs * 0.707, -rs * 0.707},
		{-rs * 0.707, rs * 0.707}, {rs * 0.707, rs * 0.707},
	}
	dc.SetRGBA(0, 0, 0, brandAlpha*0.5)
	for _, o := range offsets {
		dc.DrawString(b.Text, textX+o[0], baseline+o[1])
	}
	dc.SetRGBA(1, 1, 1, brandAlpha)
	dc.DrawString(b.Text, textX, baseline)
	return nil
}

// drawOverlay paints the persistent header (top) and shloka (center)
// zones. Each seg gets a fresh face — safe to call inside per-word
// goroutines because opentype faces are not shared.
func (r *Renderer) drawOverlay(dc *gg.Context, opts Options, ov *Overlay) error {
	maxW := int(float64(opts.SlideWidth) * maxLineRatio)

	headerBottom := float64(opts.SlideHeight) * headerTopRatio
	if ov.Header != nil {
		var segs []textSeg
		hf, err := r.Fonts.Face(headerFontSize)
		if err != nil {
			return err
		}
		segs = append(segs, textSeg{face: hf, lines: wrapText(hf, ov.Header.Text, maxW)})
		if strings.TrimSpace(ov.Header.Sub) != "" {
			sf, err := r.Fonts.Face(headerSubSize)
			if err != nil {
				return err
			}
			segs = append(segs, textSeg{face: sf, lines: wrapText(sf, ov.Header.Sub, maxW)})
		}
		headerBottom = drawBlock(dc, opts, segs, float64(opts.SlideHeight)*headerTopRatio)
	}

	if ov.Center != nil {
		var segs []textSeg
		if strings.TrimSpace(ov.Center.IAST) != "" {
			f, err := r.Fonts.Face(shlokaIASTSize)
			if err != nil {
				return err
			}
			segs = append(segs, textSeg{face: f, lines: wrapText(f, ov.Center.IAST, maxW)})
		}
		if strings.TrimSpace(ov.Center.Translation) != "" {
			f, err := r.Fonts.Face(shlokaTransSize)
			if err != nil {
				return err
			}
			segs = append(segs, textSeg{face: f, lines: wrapText(f, ov.Center.Translation, maxW)})
		}
		top := float64(opts.SlideHeight)*shlokaMidRatio - blockHeight(segs)/2
		drawBlock(dc, opts, segs, top)
	}

	if ov.Brand != nil {
		if err := r.drawBrand(dc, opts, ov.Brand, headerBottom); err != nil {
			return err
		}
	}
	return nil
}

// GeneratePersistentFrame renders one full-duration PNG carrying only the
// overlay (no transcript). Used when the transcript section is disabled:
// the reel shows a static header/center over the audio.
func (r *Renderer) GeneratePersistentFrame(overlay *Overlay, duration float64, tempDir string) (FrameSpec, error) {
	opts := r.Opts.effective()
	if err := os.MkdirAll(tempDir, 0o755); err != nil {
		return FrameSpec{}, fmt.Errorf("mkdir %s: %w", tempDir, err)
	}
	face, err := r.Fonts.Face(opts.FontSize)
	if err != nil {
		return FrameSpec{}, err
	}
	path := filepath.Join(tempDir, "persistent.png")
	if err := r.drawSingleFrame(path, face, opts, "", -1, nil, overlay); err != nil {
		return FrameSpec{}, err
	}
	return FrameSpec{Path: path, Duration: duration, StartTime: 0}, nil
}

// GenerateTitleFrame renders the cream title-card frame: icon + title
// text stacked and vertically centered. Uses a smaller font (90% of
// body size) and dark text on cream bg. withIcon=false suppresses the
// branded icon (intro.icon toggle) and re-centers the title alone.
func (r *Renderer) GenerateTitleFrame(title, outPath string, withIcon bool) error {
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

	showIcon := withIcon && r.IconPNG != ""
	iconSize := int(math.Round(float64(opts.SlideWidth) * 0.35))
	iconTitleGap := int(math.Round(float64(opts.SlideHeight) * 0.047))

	var titleStartY float64
	if showIcon {
		groupHeight := float64(iconSize+iconTitleGap) + totalTextHeight
		iconX := (opts.SlideWidth - iconSize) / 2
		iconY := int(math.Round((float64(opts.SlideHeight) - groupHeight) / 2))
		if img, err := loadPNG(r.IconPNG); err == nil {
			scaled := image.NewRGBA(image.Rect(0, 0, iconSize, iconSize))
			draw.CatmullRom.Scale(scaled, scaled.Bounds(), img, img.Bounds(), draw.Over, nil)
			dc.DrawImage(scaled, iconX, iconY)
		}
		// If load fails we silently render without the icon — same
		// "ignore" semantics as videoGenerator.ts:325-327.
		titleStartY = float64(iconY + iconSize + iconTitleGap)
	} else {
		// Icon suppressed: center the title text alone.
		titleStartY = (float64(opts.SlideHeight) - totalTextHeight) / 2
	}

	dc.SetHexColor(titleText)
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
