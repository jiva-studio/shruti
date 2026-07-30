// Package outline is the shared, source-agnostic step that turns a reviewed
// transcript into a coarse chapter outline (headings with [start,end) spans),
// a private granular heading list (for the offline topic pipeline), and a
// short description.
//
// It is the DOMAIN logic both ingest paths speak — the shruti-mcp corpus
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

	outlineport "github.com/jiva-studio/shruti/pipeline/ports/outline"
	"github.com/jiva-studio/shruti/pipeline/transcript"
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
) (Result, error) {
	lectureText, duration := lectureFromBlocks(blocks)
	if strings.TrimSpace(lectureText) == "" {
		return Result{}, fmt.Errorf("outline: no transcript text")
	}

	res, err := gen.Outline(ctx, lectureText, language)
	if err != nil {
		return Result{}, err
	}
	desc, err := gen.Description(ctx, lectureText, language)
	if err != nil {
		return Result{}, err
	}
	return Result{
		Coarse:      buildEntries(res.Coarse, duration),
		Granular:    buildEntries(res.Granular, duration),
		Description: desc,
	}, nil
}

// lectureFromBlocks renders the reviewed transcript as time-coded lines
// ("[HH:MM:SS] text"), one per non-empty block, and returns the lecture
// duration (the latest block end) for clamping/end-derivation.
func lectureFromBlocks(blocks []transcript.Block) (string, int64) {
	var b strings.Builder
	var duration int64
	for _, blk := range blocks {
		if end := blk.EndMs(); end > duration {
			duration = end
		}
		text := strings.TrimSpace(blockText(blk))
		if text == "" {
			continue
		}
		fmt.Fprintf(&b, "[%s] %s\n", fmtTS(blk.StartMs()), text)
	}
	return b.String(), duration
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
func buildEntries(items []outlineport.Item, duration int64) []Entry {
	sort.SliceStable(items, func(i, j int) bool { return items[i].StartMs < items[j].StartMs })

	cleaned := make([]outlineport.Item, 0, len(items))
	var lastStart int64 = -1
	for _, it := range items {
		title := strings.TrimSpace(it.Title)
		if title == "" {
			continue
		}
		start := it.StartMs
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
