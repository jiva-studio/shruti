package review

import (
	"context"
	"strings"
	"sync"

	reviewport "github.com/jiva-studio/lectorium/pipeline/ports/review"
	"github.com/jiva-studio/lectorium/pipeline/transcript"
)

// Options tunes ReviewTranscript. Zero values fall back to sane defaults.
type Options struct {
	ChunkSize   int // segments per review window (default 50)
	Overlap     int // window overlap between chunks (default 10)
	Retries     int // per-chunk idx-mismatch retries (default 1)
	Concurrency int // max concurrent chunk reviews (default 4)
}

// ReviewTranscript runs an LLM reviewer over a raw transcript and assembles the
// corrected, sentence-segmented Reviewed artifact. It is the PURE core of the
// review pipeline — the chunk → review → edge-distance merge → boundary voting →
// block assembly loop — with none of the corpus tool's persistence, resume,
// glossary, attempt-chain, or splitter machinery (a stateless worker can run it
// with just a reviewer + prompts). A chunk whose review fails falls back to its
// raw text, so the result always covers every segment. The reviewer never sees
// timestamps; they are carried verbatim from the raw segments.
func ReviewTranscript(
	ctx context.Context,
	reviewer reviewport.Reviewer,
	raw transcript.Raw,
	opts Options,
) transcript.Reviewed {
	size := opts.ChunkSize
	if size <= 0 {
		size = 50
	}
	overlap := opts.Overlap
	if overlap < 0 {
		overlap = 0
	}
	retries := opts.Retries
	if retries < 0 {
		retries = 0
	}
	concurrency := opts.Concurrency
	if concurrency <= 0 {
		concurrency = 4
	}
	lang := raw.Language

	// idxText starts as the raw text; a reviewed chunk overrides it by edge
	// distance (a chunk that saw more context around an idx wins the edit).
	idxText := make(map[int]string, len(raw.Segments))
	idxEdge := make(map[int]int, len(raw.Segments))
	for _, s := range raw.Segments {
		idxText[s.Idx] = s.Text
		idxEdge[s.Idx] = -1
	}

	// Pre-build chunk segments + read-only prev-tail context so chunks are
	// independent and can run in parallel.
	chunks := BuildChunks(raw.Segments, size, overlap)
	chunkSegs := make([][]reviewport.ChunkSegment, len(chunks))
	prevTails := make([][]reviewport.ChunkSegment, len(chunks))
	for i, ck := range chunks {
		chunkSegs[i] = reviewport.ChunkSegmentsFromRaw(ck.Segs)
		if i > 0 {
			prevTails[i] = LastN(chunkSegs[i-1], overlap)
		}
	}

	type chunkResult struct {
		segs      []reviewport.ChunkSegment
		sentences [][]int
		ok        bool
	}
	results := make([]chunkResult, len(chunks))
	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup
	for i := range chunks {
		i := i
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			att := TryReview(ctx, reviewer, reviewport.ChunkRequest{
				Language: lang,
				Segments: chunkSegs[i],
				PrevTail: prevTails[i],
			}, retries)
			if att.Err == nil {
				results[i] = chunkResult{segs: att.Final.Segments, sentences: att.Final.Sentences, ok: true}
			}
		}()
	}
	wg.Wait()

	// Per raw idx: apply text edits + a best-edge-distance sentence-end verdict.
	boundaries := make([]IdxBoundary, len(raw.Segments))
	idxToPos := make(map[int]int, len(raw.Segments))
	for i, s := range raw.Segments {
		idxToPos[s.Idx] = i
		boundaries[i].EdgeDist = -1
	}
	for _, r := range results {
		if !r.ok {
			continue
		}
		for i, s := range r.segs {
			if dist := MinInt(i, len(r.segs)-1-i); dist > idxEdge[s.Idx] {
				idxText[s.Idx] = s.Text
				idxEdge[s.Idx] = dist
			}
		}
		endIdx, ok := BuildEndSet(r.segs, r.sentences)
		if !ok {
			continue
		}
		for i, s := range r.segs {
			rp, present := idxToPos[s.Idx]
			if !present {
				continue
			}
			// Right-edge distance = how much context the model saw AFTER this
			// idx, which is what makes a sentence-end verdict reliable.
			if distRight := len(r.segs) - 1 - i; distRight > boundaries[rp].EdgeDist || !boundaries[rp].HasInfo {
				boundaries[rp].EdgeDist = distRight
				boundaries[rp].IsEnd = endIdx[s.Idx]
				boundaries[rp].HasInfo = true
			}
		}
	}
	// The last raw segment always closes the final sentence.
	if n := len(raw.Segments); n > 0 {
		boundaries[n-1].IsEnd = true
	}

	// Walk raw segments in order; emit one SentenceBlock per detected sentence.
	// No boundary info for an idx → treat it as its own sentence (never drop).
	blocks := make([]transcript.Block, 0, len(raw.Segments))
	var (
		curStart int64
		curParts []string
		curOpen  bool
	)
	for i, s := range raw.Segments {
		if !curOpen {
			curStart = s.Start
			curParts = curParts[:0]
			curOpen = true
		}
		if t := strings.TrimSpace(idxText[s.Idx]); t != "" {
			curParts = append(curParts, t)
		}
		if boundaries[i].IsEnd || !boundaries[i].HasInfo {
			blocks = append(blocks, transcript.SentenceBlock{
				Start: curStart,
				End:   s.End,
				Text:  strings.Join(curParts, " "),
			})
			curOpen = false
		}
	}
	if curOpen && len(raw.Segments) > 0 {
		last := raw.Segments[len(raw.Segments)-1]
		blocks = append(blocks, transcript.SentenceBlock{
			Start: curStart,
			End:   last.End,
			Text:  strings.Join(curParts, " "),
		})
	}

	return transcript.Reviewed{
		TrackId:  raw.TrackId,
		Language: lang,
		Version:  1,
		Blocks:   blocks,
	}
}
