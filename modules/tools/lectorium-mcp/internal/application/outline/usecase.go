// Package outline generates a per-lecture section outline (coarse chapter
// headings with timecodes) and a short description from the reviewed
// transcript, and writes both onto the committed catalog variant.
//
// The whole transcript is sent to the LLM in one pass (no chunking) — the
// generator owns the granular-then-collapse logic; this use case owns reading
// the transcript, deriving each heading's end span, and the catalog write.
package outline

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
	"github.com/jiva-studio/lectorium/pipeline/transcript"
	outlineport "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/outline"
	transcriptport "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/transcript"
)

// CatalogWriter is the slice of the catalog the outline use case writes: a
// targeted UPDATE of one (track, language) variant's outline + description. It
// does not touch title/audio/refs, so it's safe to run post-commit over the
// corpus.
type CatalogWriter interface {
	SetVariantOutline(ctx context.Context, trackID, language, outline, description string) error
}

// GranularStore persists the private, offline-only granular outline artifact
// (the pre-collapse fine heading list, each with a derived [start,end) span)
// for the topic-vocabulary pipeline. It is NOT published to the client catalog.
// Optional: a nil GranularStore disables the write (the published coarse
// outline is unaffected).
type GranularStore interface {
	WriteGranularOutline(ctx context.Context, id track.Id, language string, granularJSON []byte) error
}

type UseCase struct {
	Transcripts transcriptport.Store
	LLM         outlineport.Generator
	Catalog     CatalogWriter
	// Granular (optional) receives the fine pre-collapse headings as a private
	// artifact. nil = skip.
	Granular GranularStore
}

// Entry is one stored outline heading: title + [start,end) span in ms. Mirrors
// the JSON persisted in track_variants.outline.
type Entry struct {
	Title string `json:"title"`
	Start int64  `json:"start"`
	End   int64  `json:"end"`
}

type Result struct {
	TrackId     string  `json:"trackId"`
	Language    string  `json:"language"`
	Outline     []Entry `json:"outline"`
	Description string  `json:"description"`
}

func (uc UseCase) Run(ctx context.Context, id track.Id, language string) (Result, error) {
	rev, err := uc.Transcripts.ReadReviewed(ctx, id, language)
	if err != nil {
		// os.ErrNotExist (no reviewed transcript) bubbles up so the fan-out
		// driver reports a clean per-track failure instead of crashing.
		return Result{}, fmt.Errorf("read reviewed transcript: %w", err)
	}
	lectureText, duration := lectureFromBlocks(rev.Blocks)
	if strings.TrimSpace(lectureText) == "" {
		return Result{}, fmt.Errorf("no transcript text for %s/%s", id, language)
	}

	res, err := uc.LLM.Outline(ctx, lectureText, language)
	if err != nil {
		return Result{}, err
	}
	entries := buildEntries(res.Coarse, duration)

	desc, err := uc.LLM.Description(ctx, lectureText, language)
	if err != nil {
		return Result{}, err
	}

	// Persist the granular pass as a private offline artifact BEFORE the catalog
	// write, so a granular-write failure surfaces as a clean re-runnable per-track
	// failure rather than leaving a published outline without its topic precursor.
	if uc.Granular != nil {
		granular := buildEntries(res.Granular, duration)
		granularJSON, err := json.Marshal(granular)
		if err != nil {
			return Result{}, fmt.Errorf("marshal granular outline: %w", err)
		}
		if err := uc.Granular.WriteGranularOutline(ctx, id, language, granularJSON); err != nil {
			return Result{}, fmt.Errorf("write granular outline: %w", err)
		}
	}

	outlineJSON, err := json.Marshal(entries)
	if err != nil {
		return Result{}, fmt.Errorf("marshal outline: %w", err)
	}
	if err := uc.Catalog.SetVariantOutline(ctx, string(id), language, string(outlineJSON), desc); err != nil {
		return Result{}, fmt.Errorf("write outline: %w", err)
	}
	return Result{TrackId: string(id), Language: language, Outline: entries, Description: desc}, nil
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
