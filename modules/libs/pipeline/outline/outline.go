// Package outline is the shared, source-agnostic step that turns a reviewed
// transcript into a coarse chapter outline (headings with [start,end) spans),
// a private granular heading list (for the offline topic pipeline), and a
// short description.
//
// It is the DOMAIN logic both ingest paths speak — the lectorium-mcp corpus
// pipeline and the personal-library ingest worker. It owns rendering the
// transcript into the LLM's time-coded input and deriving each heading's end
// span; it does NOT persist anything. Each caller maps Result into its own
// sink (mcp's catalog + granular artifact, ingest's Result payload). Pure,
// stdlib + shared transcript/port only.
package outline

import (
	"context"
	"fmt"
	"sort"
	"strings"

	outlineport "github.com/jiva-studio/lectorium/pipeline/ports/outline"
	"github.com/jiva-studio/lectorium/pipeline/transcript"
)

// Entry is one stored outline heading: title + [start,end) span in ms.
type Entry struct {
	Title string `json:"title"`
	Start int64  `json:"start"`
	End   int64  `json:"end"`
}

// Result is the outcome of one generation: the coarse chapters a catalog
// publishes, the granular headings feeding the offline topic pipeline, and a
// short description. All spans are clamped to the lecture duration.
type Result struct {
	Coarse      []Entry
	Granular    []Entry
	Description string
}

// Generate runs the generator over the reviewed transcript's blocks and returns
// the coarse + granular entries and the description. The whole transcript is
// sent in one pass (no chunking) — the generator owns the granular-then-collapse
// logic; this function owns rendering the input and deriving end spans.
func Generate(
	ctx context.Context,
	gen outlineport.Generator,
	blocks []transcript.Block,
	language string,
	compress Compressor,
) (Result, error) {
	lectureText, _, _ := LectureText(blocks, compress)
	if strings.TrimSpace(lectureText) == "" {
		return Result{}, fmt.Errorf("outline: no transcript text")
	}

	res, err := gen.Outline(ctx, lectureText, language)
	if err != nil {
		return Result{}, err
	}
	return Assemble(blocks, compress, res.Granular, res.Coarse, res.Description), nil
}

// LectureText renders the transcript the model reads: one line per non-empty
// block, compressed text with its time-code in front. Also returns the lecture
// duration and the block starts, which the assembly step needs.
//
// Exported because the batch path builds the same request without going through
// a Generator — the input has to be byte-identical either way.
func LectureText(blocks []transcript.Block, compress Compressor) (string, int64, []int64) {
	return lectureFromBlocks(blocks, compress)
}

// Assemble turns the model's headings into the stored result: starts snapped to
// real block boundaries, ends derived, coarse chapters thinned.
//
// The batch path passes the same list as granular and coarse: it cannot run the
// merge round trip, so the coarse list is collapsed locally — which is what the
// synchronous path falls back to when its merge fails.
func Assemble(
	blocks []transcript.Block,
	compress Compressor,
	granular, coarse []outlineport.Item,
	description string,
) Result {
	_, duration, starts := lectureFromBlocks(blocks, compress)
	return Result{
		// The coarse chapters are the ones rendered as headings, so thin them: a
		// short lecture must not sprout a heading every couple of sentences.
		Coarse:      thinChapters(buildEntries(coarse, duration, starts), duration),
		Granular:    buildEntries(granular, duration, starts),
		Description: description,
	}
}

// Chapter spacing decides how many chapters a lecture gets. There used to be a
// hard ceiling of eight on top, applied by dropping every k-th heading until the
// list fit: it made every lecture come out at exactly eight regardless of
// length, and the headings it dropped were chosen by position rather than by
// being minor.
//
// The gap scales with the lecture because one fixed value cannot serve both
// ends: three minutes gives a two-hour talk ten chapters and a nine-minute one
// two, having thrown away half of what it had to say.
const (
	maxChapterGapMs = 180_000
	minChapterGapMs = 60_000
	// chapterGapDivisor targets roughly this many chapters before the clamps
	// take over.
	chapterGapDivisor = 8
)

func chapterGapMs(duration int64) int64 {
	gap := duration / chapterGapDivisor
	if gap > maxChapterGapMs {
		return maxChapterGapMs
	}
	if gap < minChapterGapMs {
		return minChapterGapMs
	}
	return gap
}

// thinChapters enforces a minimum time gap between coarse chapters, re-deriving
// each kept chapter's [start,end) span. The first chapter is always kept.
func thinChapters(entries []Entry, duration int64) []Entry {
	if len(entries) <= 1 {
		return entries
	}
	gap := chapterGapMs(duration)
	kept := []Entry{entries[0]}
	for _, e := range entries[1:] {
		if e.Start-kept[len(kept)-1].Start >= gap {
			kept = append(kept, e)
		}
	}
	for i := range kept {
		if i+1 < len(kept) {
			kept[i].End = kept[i+1].Start
		} else {
			kept[i].End = duration
		}
		if kept[i].End < kept[i].Start {
			kept[i].End = kept[i].Start
		}
	}
	return kept
}

// lectureFromBlocks renders the reviewed transcript as time-coded lines
// ("[HH:MM:SS] text"), one per non-empty block, and returns the lecture
// duration (the latest block end) for clamping/end-derivation plus the block
// starts, which are the only timecodes a heading may legitimately carry.
//
// Compression runs on the text and the marker is written after it, so the
// marker is never an input to the compressor.
func lectureFromBlocks(blocks []transcript.Block, c Compressor) (string, int64, []int64) {
	var b strings.Builder
	var duration int64
	starts := make([]int64, 0, len(blocks))
	for _, blk := range blocks {
		if end := blk.EndMs(); end > duration {
			duration = end
		}
		text := strings.TrimSpace(blockText(blk))
		if c != nil {
			text = strings.TrimSpace(c.Compress(text))
		}
		if text == "" {
			continue
		}
		starts = append(starts, blk.StartMs())
		fmt.Fprintf(&b, "[%s] %s\n", fmtTS(blk.StartMs()), text)
	}
	return b.String(), duration, starts
}

// snapToBlock moves a heading start onto the nearest block boundary at or
// before it. The model occasionally reports a timecode that appears nowhere in
// the transcript — measured at one heading in 65 — and an invented start puts a
// chapter in the middle of a sentence.
func snapToBlock(ms int64, starts []int64) int64 {
	if len(starts) == 0 {
		return ms
	}
	i := sort.Search(len(starts), func(i int) bool { return starts[i] > ms })
	if i == 0 {
		return starts[0]
	}
	return starts[i-1]
}

func blockText(b transcript.Block) string {
	switch v := b.(type) {
	case transcript.SentenceBlock:
		return v.Text
	case transcript.VerseTextBlock:
		return strings.Join(v.Text, " ")
	case transcript.VerseTranslationBlock:
		return v.Text
	default:
		return "" // paragraph carries no text
	}
}

// buildEntries cleans the LLM headings (clamp to [0,duration], strictly
// increasing starts, drop empties/dupes) and derives each heading's end as the
// next heading's start — the last one runs to the lecture duration.
func buildEntries(items []outlineport.Item, duration int64, starts []int64) []Entry {
	sort.SliceStable(items, func(i, j int) bool { return items[i].StartMs < items[j].StartMs })

	cleaned := make([]outlineport.Item, 0, len(items))
	var lastStart int64 = -1
	for _, it := range items {
		title := strings.TrimSpace(it.Title)
		if title == "" {
			continue
		}
		start := snapToBlock(it.StartMs, starts)
		if start < 0 {
			start = 0
		}
		if duration > 0 && start > duration {
			start = duration
		}
		if len(cleaned) > 0 && start <= lastStart {
			continue // non-monotonic / duplicate start — keep the earlier heading
		}
		cleaned = append(cleaned, outlineport.Item{Title: title, StartMs: start})
		lastStart = start
	}

	entries := make([]Entry, len(cleaned))
	for i, it := range cleaned {
		end := duration
		if i+1 < len(cleaned) {
			end = cleaned[i+1].StartMs
		}
		if end < it.StartMs {
			end = it.StartMs
		}
		entries[i] = Entry{Title: it.Title, Start: it.StartMs, End: end}
	}
	return entries
}

func fmtTS(ms int64) string {
	if ms < 0 {
		ms = 0
	}
	s := ms / 1000
	h := s / 3600
	m := (s % 3600) / 60
	sec := s % 60
	if h > 0 {
		return fmt.Sprintf("%02d:%02d:%02d", h, m, sec)
	}
	return fmt.Sprintf("%02d:%02d", m, sec)
}
