package review

import (
	"context"
	"sort"
	"strings"

	pipelinereview "github.com/jiva-studio/shruti/pipeline/review"
	"github.com/jiva-studio/shruti/pipeline/transcript"
)

// merged is the track's text and sentence boundaries after every chunk.
type merged struct {
	idxText     map[int]string
	boundaries  []pipelinereview.IdxBoundary // by raw position
	fallbackIdx []int                        // sorted
	succeeded   int
}

// merge folds the chunk results into one text per raw idx and one sentence
// boundary verdict per raw position.
//
// Where chunks overlap, the text from the chunk in which the segment sits
// farthest from an edge wins. A sentence-end verdict is taken from the chunk
// that saw the most text after the segment, since that decides whether a
// sentence closes there or runs on. With a splitter configured, boundaries
// are recomputed from the merged text instead, which holds even when every
// chunk's sentence grouping was broken.
func (uc UseCase) merge(ctx context.Context, segs []transcript.RawSegment, results []chunkResult) merged {
	m := merged{
		idxText:    make(map[int]string, len(segs)),
		boundaries: make([]pipelinereview.IdxBoundary, len(segs)),
	}
	edgeDist := make(map[int]int, len(segs))
	idxToPos := make(map[int]int, len(segs))
	for i, s := range segs {
		m.idxText[s.Idx] = s.Text
		edgeDist[s.Idx] = -1
		idxToPos[s.Idx] = i
		m.boundaries[i].EdgeDist = -1
	}

	fallback := map[int]struct{}{}
	for _, r := range results {
		if len(r.fallback) > 0 {
			for _, idx := range r.fallback {
				fallback[idx] = struct{}{}
			}
			continue
		}
		m.succeeded++
		for i, s := range r.segs {
			dist := pipelinereview.MinInt(i, len(r.segs)-1-i)
			if dist > edgeDist[s.Idx] {
				m.idxText[s.Idx] = s.Text
				edgeDist[s.Idx] = dist
			}
		}
		// Sentences that do not cover the chunk's idx set are ignored.
		endIdx, ok := pipelinereview.BuildEndSet(r.segs, r.sentences)
		if !ok {
			continue
		}
		for i, s := range r.segs {
			distRight := len(r.segs) - 1 - i
			rp, present := idxToPos[s.Idx]
			if !present {
				continue
			}
			if distRight > m.boundaries[rp].EdgeDist || !m.boundaries[rp].HasInfo {
				m.boundaries[rp] = pipelinereview.IdxBoundary{EdgeDist: distRight, IsEnd: endIdx[s.Idx], HasInfo: true}
			}
		}
	}
	for idx := range fallback {
		m.fallbackIdx = append(m.fallbackIdx, idx)
	}
	sort.Ints(m.fallbackIdx)

	if uc.Splitter != nil {
		if b, ok := pipelinereview.SplitWithRazdel(ctx, uc.Splitter, segs, m.idxText); ok {
			m.boundaries = b
		}
	}
	// The last segment always closes the final sentence.
	if n := len(segs); n > 0 {
		m.boundaries[n-1].IsEnd = true
	}
	return m
}

// buildBlocks emits one sentence block per detected sentence, in raw order. A
// segment no chunk said anything about is a sentence of its own, so no
// content is dropped.
func buildBlocks(segs []transcript.RawSegment, m merged) []transcript.Block {
	blocks := make([]transcript.Block, 0, len(segs))
	var (
		start int64
		parts []string
		open  bool
	)
	for i, s := range segs {
		if !open {
			start, parts, open = s.Start, parts[:0], true
		}
		if t := strings.TrimSpace(m.idxText[s.Idx]); t != "" {
			parts = append(parts, t)
		}
		if m.boundaries[i].IsEnd || !m.boundaries[i].HasInfo {
			blocks = append(blocks, transcript.SentenceBlock{Start: start, End: s.End, Text: strings.Join(parts, " ")})
			open = false
		}
	}
	return blocks
}
