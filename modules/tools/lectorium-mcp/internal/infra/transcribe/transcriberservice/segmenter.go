package transcriberservice

import (
	"strings"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/transcript"
)

const (
	// Segmenter targets — chosen to mimic whisper.cpp's natural segment
	// shape (~3-5s) so review's chunk_size=50 keeps making sense across
	// providers. Sentence-boundary detection is review's job (LLM); we
	// just produce well-sized fragments.
	maxSegmentMillis = 5_000
	maxSegmentWords  = 30
)

// segmentWordTimings groups per-word timings into RawSegments. Cuts
// when the running window crosses any of:
//   - max wall span (5s),
//   - max word count (30),
//   - the previous word ended in `.` `!` or `?` (strong terminator).
//
// Empty wordTimings → empty Segments. No words → idx 0..N never emitted,
// downstream commit will fail validation, which is correct behaviour.
func segmentWordTimings(words []WordTiming) []transcript.RawSegment {
	if len(words) == 0 {
		return nil
	}
	out := make([]transcript.RawSegment, 0, len(words)/10+1)

	type accum struct {
		start   int64 // ms
		end     int64 // ms
		words   []string
		idx     int
		confSum float64
		confN   int
	}
	var cur accum
	cur.idx = 0
	cur.start = -1

	flush := func() {
		if len(cur.words) == 0 {
			return
		}
		var conf float64
		if cur.confN > 0 {
			conf = cur.confSum / float64(cur.confN)
		}
		out = append(out, transcript.RawSegment{
			Idx:        cur.idx,
			Start:      cur.start,
			End:        cur.end,
			Text:       strings.TrimSpace(strings.Join(cur.words, " ")),
			Confidence: conf,
		})
		cur.idx++
		cur.start = -1
		cur.end = 0
		cur.words = cur.words[:0]
		cur.confSum = 0
		cur.confN = 0
	}

	for i, w := range words {
		startMs := int64(w.StartTime * 1000)
		endMs := int64(w.EndTime * 1000)
		if cur.start < 0 {
			cur.start = startMs
		}
		cur.end = endMs
		cur.words = append(cur.words, strings.TrimSpace(w.Word))
		cur.confSum += w.Confidence
		cur.confN++

		// Decide whether to cut after this word.
		spanFull := endMs-cur.start >= maxSegmentMillis
		countFull := len(cur.words) >= maxSegmentWords
		terminator := endsWithStrongPunct(w.Word)
		// Don't emit a tiny tail segment of a single word from the very
		// last chunk-cut into the next one — flush on the last item too.
		isLast := i == len(words)-1

		if spanFull || countFull || terminator || isLast {
			flush()
		}
	}
	return out
}

func endsWithStrongPunct(word string) bool {
	w := strings.TrimSpace(word)
	if w == "" {
		return false
	}
	last := w[len(w)-1]
	return last == '.' || last == '!' || last == '?'
}
