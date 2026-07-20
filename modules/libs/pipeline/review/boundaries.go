package review

import (
	"context"
	"strings"
	"unicode/utf8"

	reviewport "github.com/jiva-studio/lectorium/pipeline/ports/review"
	"github.com/jiva-studio/lectorium/pipeline/ports/sentencesplit"
	"github.com/jiva-studio/lectorium/pipeline/transcript"
)

// IdxBoundary tracks which raw idx is the final segment of a sentence.
// Two writers populate it:
//   - LLM-derived voting (one entry per chunk, edge-distance preference)
//   - razdel splitter (when a Splitter is set, runs once on the merged
//     corrected text and overrides the voting result)
type IdxBoundary struct {
	EdgeDist int
	IsEnd    bool
	HasInfo  bool
}

// SplitWithRazdel concatenates the corrected text in idx order, asks
// the splitter for sentence boundaries by character offset, and maps
// those back to per-segment IsEnd flags. On any error returns ok=false
// so the caller keeps the LLM-derived boundaries as fallback.
//
// Each segment's text in the merged passage is followed by a single
// space; we record (start,end) RUNE offsets so we can map razdel's
// character-based sentence ranges back to idx positions correctly for
// non-ASCII (Russian, Sanskrit IAST) where one character ≠ one byte.
func SplitWithRazdel(ctx context.Context, splitter sentencesplit.Splitter, raw []transcript.RawSegment, idxText map[int]string) ([]IdxBoundary, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	var b strings.Builder
	starts := make([]int, len(raw))
	ends := make([]int, len(raw))
	runePos := 0
	for i, s := range raw {
		text := strings.TrimSpace(idxText[s.Idx])
		starts[i] = runePos
		b.WriteString(text)
		runePos += utf8.RuneCountInString(text)
		ends[i] = runePos
		if i < len(raw)-1 {
			b.WriteByte(' ')
			runePos++
		}
	}
	merged := b.String()
	sents, err := splitter.Split(ctx, merged)
	if err != nil || len(sents) == 0 {
		return nil, false
	}
	boundaries := make([]IdxBoundary, len(raw))
	for i := range boundaries {
		boundaries[i].EdgeDist = -1
	}
	// For each sentence find the last segment whose char range overlaps
	// it; mark that one as IsEnd.
	for _, sent := range sents {
		lastSeg := -1
		for i := range raw {
			if starts[i] >= sent.Stop {
				break
			}
			if ends[i] > sent.Start && starts[i] < sent.Stop {
				lastSeg = i
			}
		}
		if lastSeg >= 0 {
			boundaries[lastSeg].IsEnd = true
			boundaries[lastSeg].HasInfo = true
		}
	}
	for i := range boundaries {
		boundaries[i].HasInfo = true
	}
	return boundaries, true
}

// BuildEndSet validates that `sentences` covers exactly the chunk's idx set,
// each idx exactly once, and returns the set of "last idx in group" values.
// Returns ok=false if the model violated the contract — caller should ignore
// sentence info from that chunk and fall back to per-segment blocks.
func BuildEndSet(segs []reviewport.ChunkSegment, sentences [][]int) (map[int]bool, bool) {
	if len(sentences) == 0 {
		return nil, false
	}
	want := make(map[int]struct{}, len(segs))
	for _, s := range segs {
		want[s.Idx] = struct{}{}
	}
	seen := make(map[int]struct{}, len(segs))
	endSet := make(map[int]bool, len(sentences))
	for _, group := range sentences {
		if len(group) == 0 {
			return nil, false
		}
		for j, idx := range group {
			if _, ok := want[idx]; !ok {
				return nil, false
			}
			if _, dup := seen[idx]; dup {
				return nil, false
			}
			seen[idx] = struct{}{}
			if j > 0 && idx <= group[j-1] {
				return nil, false // group must be ascending
			}
		}
		endSet[group[len(group)-1]] = true
	}
	if len(seen) != len(want) {
		return nil, false // not all idxs covered
	}
	return endSet, true
}
