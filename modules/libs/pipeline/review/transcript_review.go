package review

import (
	"context"
	"strings"
	"sync"

	glossaryport "github.com/jiva-studio/shruti/pipeline/ports/glossary"
	reviewport "github.com/jiva-studio/shruti/pipeline/ports/review"
	"github.com/jiva-studio/shruti/pipeline/transcript"
)

// Options tunes ReviewTranscript. Zero values fall back to sane defaults.
type Options struct {
	ChunkSize   int // segments per review window (default 50)
	Overlap     int // window overlap between chunks (default 10)
	Retries     int // per-chunk idx-mismatch retries (default 1)
	Concurrency int // max concurrent chunk reviews (default 4)
	// Glossary, when set, injects canonical-term hints (RAG-style) into each
	// chunk's ExtraPrompt so the LLM corrects ASR spellings of Sanskrit terms
	// and proper nouns. Threshold/MaxHints fall back to 0.55 / 10.
	Glossary          glossaryport.Matcher
	GlossaryThreshold float64
	GlossaryMaxHints  int
}

// ReviewTranscript runs an LLM reviewer over a raw transcript and assembles the
// corrected, sentence-segmented Reviewed artifact. It is the PURE core of the
// review pipeline — the chunk → review → edge-distance merge → boundary voting →
// block assembly loop — with none of the corpus tool's persistence, resume,
// attempt-chain, or splitter machinery (a stateless worker can run it with just
// a reviewer + prompts, plus an optional glossary via Options). A chunk whose
// review fails falls back to its
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
				Language:    lang,
				Segments:    chunkSegs[i],
				PrevTail:    prevTails[i],
				ExtraPrompt: glossaryHints(opts, chunkSegs[i], lang),
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
		curStart    int64
		curParts    []string
		curSpeakers map[string]int
		curOpen     bool
	)
	for i, s := range raw.Segments {
		if !curOpen {
			curStart = s.Start
			curParts = curParts[:0]
			curSpeakers = map[string]int{}
			curOpen = true
		}
		if s.Speaker != "" {
			curSpeakers[s.Speaker]++
		}
		if t := strings.TrimSpace(idxText[s.Idx]); t != "" {
			curParts = append(curParts, t)
		}
		if boundaries[i].IsEnd || !boundaries[i].HasInfo {
			blocks = append(blocks, transcript.SentenceBlock{
				Start:   curStart,
				End:     s.End,
				Text:    strings.Join(curParts, " "),
				Speaker: dominantSpeaker(curSpeakers),
			})
			curOpen = false
		}
	}
	if curOpen && len(raw.Segments) > 0 {
		last := raw.Segments[len(raw.Segments)-1]
		blocks = append(blocks, transcript.SentenceBlock{
			Start:   curStart,
			End:     last.End,
			Text:    strings.Join(curParts, " "),
			Speaker: dominantSpeaker(curSpeakers),
		})
	}

	return transcript.Reviewed{
		TrackID:  raw.TrackID,
		Language: lang,
		Version:  1,
		Blocks:   blocks,
	}
}

// dominantSpeaker returns the most-voted diarizer label across the segments
// merged into one sentence, ties broken by the lower label for determinism;
// "" when no segment carried a speaker.
func dominantSpeaker(counts map[string]int) string {
	best := ""
	bestN := 0
	for label, n := range counts {
		if n > bestN || (n == bestN && best != "" && label < best) {
			best, bestN = label, n
		}
	}
	return best
}

// glossaryHints renders the canonical-term hint block for one chunk (empty when
// no glossary is configured or nothing matches).
func glossaryHints(opts Options, segs []reviewport.ChunkSegment, lang string) string {
	if opts.Glossary == nil {
		return ""
	}
	thr := opts.GlossaryThreshold
	if thr <= 0 {
		thr = 0.55
	}
	maxH := opts.GlossaryMaxHints
	if maxH <= 0 {
		maxH = 10
	}
	var b strings.Builder
	for _, s := range segs {
		b.WriteString(s.Text)
		b.WriteByte(' ')
	}
	return opts.Glossary.RenderHints(b.String(), lang, thr, maxH)
}
