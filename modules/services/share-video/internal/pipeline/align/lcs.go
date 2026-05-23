// Package align force-aligns caller-supplied text to Whisper/SpeechKit
// word-level timestamps, then groups the aligned word stream into
// slides of at most maxCharsPerSlide characters.
//
// Why force-align at all: caller text has clean punctuation/casing we
// want to render; Whisper/SpeechKit have reliable word boundaries we
// want for highlighting. We pair them up so rendered surface form is
// the caller's, but the timing is from the recogniser.
//
// Direct port of src/utils/forceAlign.ts.
package align

import (
	"math"
	"strings"
	"unicode"

	"github.com/akdasa-studios/shruti-share-video/internal/pipeline/transcript"
	"github.com/akdasa-studios/shruti-share-video/internal/types"
)

// Min slide gap kept here as a constant so the test data and renderer
// don't drift apart.
const minWordSpanSec = 0.05

type callerToken struct {
	surface    string
	normalised string
}

// ForceAlign returns one WordTiming per caller token, in order.
// totalDurationSec is the cut audio's length; used for fallback even
// distribution when alignment is implausible.
func ForceAlign(callerText string, whisperWords []transcript.Word, totalDurationSec float64) []types.WordTiming {
	callerTokens := tokenise(callerText)

	if len(callerTokens) == 0 {
		// No caller words → render the recogniser transcript unchanged.
		out := make([]types.WordTiming, 0, len(whisperWords))
		for _, w := range whisperWords {
			out = append(out, types.WordTiming{Word: w.Word, Start: w.Start, End: w.End})
		}
		return out
	}
	if len(whisperWords) == 0 || totalDurationSec <= 0 {
		return evenDistribution(callerTokens, totalDurationSec)
	}

	sizeRatio := math.Abs(float64(len(callerTokens)-len(whisperWords))) /
		math.Max(float64(len(callerTokens)), float64(len(whisperWords)))
	if sizeRatio > 0.5 {
		return evenDistribution(callerTokens, totalDurationSec)
	}

	callerNorm := make([]string, len(callerTokens))
	for i, t := range callerTokens {
		callerNorm[i] = t.normalised
	}
	whisperNorm := make([]string, len(whisperWords))
	for i, w := range whisperWords {
		whisperNorm[i] = normalise(w.Word)
	}

	pairs := lcsPairs(callerNorm, whisperNorm)
	if len(pairs) == 0 {
		return evenDistribution(callerTokens, totalDurationSec)
	}

	result := make([]types.WordTiming, len(callerTokens))
	anchored := make([]bool, len(callerTokens))
	anchorList := make([]int, 0, len(pairs))

	for _, p := range pairs {
		ci, wi := p[0], p[1]
		result[ci] = types.WordTiming{
			Word:  callerTokens[ci].surface,
			Start: whisperWords[wi].Start,
			End:   whisperWords[wi].End,
		}
		anchored[ci] = true
		anchorList = append(anchorList, ci)
	}

	// Interpolate non-anchored caller words. anchorList is naturally
	// sorted because lcsPairs walks both arrays in order.
	cursor := 0
	for i := 0; i < len(callerTokens); i++ {
		if anchored[i] {
			continue
		}
		for cursor < len(anchorList) && anchorList[cursor] < i {
			cursor++
		}
		prevAnchor := -1
		if cursor > 0 {
			prevAnchor = anchorList[cursor-1]
		}
		nextAnchor := -1
		if cursor < len(anchorList) {
			nextAnchor = anchorList[cursor]
		}

		var prevEnd float64
		if prevAnchor >= 0 {
			prevEnd = result[prevAnchor].End
		}
		var nextStart float64
		if nextAnchor >= 0 {
			nextStart = result[nextAnchor].Start
		} else {
			nextStart = whisperWords[len(whisperWords)-1].End
		}

		lowIdx := prevAnchor + 1
		highIdx := nextAnchor
		if highIdx < 0 {
			highIdx = len(callerTokens)
		}
		span := math.Max(0, nextStart-prevEnd)
		slots := highIdx - lowIdx
		slot := 0.0
		if slots > 0 {
			slot = span / float64(slots)
		}
		offset := i - lowIdx
		start := prevEnd + slot*float64(offset)
		end := prevEnd + slot*float64(offset+1)
		if end < start+minWordSpanSec {
			end = start + minWordSpanSec
		}
		result[i] = types.WordTiming{
			Word:  callerTokens[i].surface,
			Start: start,
			End:   end,
		}
	}

	return result
}

// WordsToSlides packs aligned timings into ≤maxCharsPerSlide slides.
// Direct port of wordsToSlides() in forceAlign.ts.
func WordsToSlides(words []types.WordTiming, maxCharsPerSlide int) []types.Slide {
	if len(words) == 0 {
		return nil
	}
	var slides []types.Slide
	var buf []types.WordTiming
	bufLen := 0

	flush := func() {
		if len(buf) == 0 {
			return
		}
		parts := make([]string, 0, len(buf))
		for _, w := range buf {
			parts = append(parts, w.Word)
		}
		startTime := buf[0].Start
		endTime := buf[len(buf)-1].End
		dur := endTime - startTime
		if dur < 0.001 {
			dur = 0.001
		}
		// Copy the slice — buf is mutated below.
		ws := append([]types.WordTiming(nil), buf...)
		slides = append(slides, types.Slide{
			Text:      strings.Join(parts, " "),
			StartTime: startTime,
			Duration:  dur,
			Words:     ws,
		})
		buf = buf[:0]
		bufLen = 0
	}

	for _, w := range words {
		additional := len(w.Word)
		if bufLen > 0 {
			additional++ // space separator
		}
		if bufLen+additional > maxCharsPerSlide && len(buf) > 0 {
			flush()
		}
		buf = append(buf, w)
		if bufLen > 0 {
			bufLen++
		}
		bufLen += len(w.Word)
	}
	flush()
	return slides
}

func tokenise(text string) []callerToken {
	var out []callerToken
	for _, raw := range strings.Fields(text) {
		n := normalise(raw)
		if n == "" {
			continue
		}
		out = append(out, callerToken{surface: raw, normalised: n})
	}
	return out
}

// punctuationToStrip matches the JS regex in forceAlign.ts:normalise.
// (Punctuation classes line up; we still keep an explicit set so
// rendering edge cases match the existing service exactly.)
var punctuationToStrip = map[rune]struct{}{
	'.': {}, ',': {}, '!': {}, '?': {}, ';': {}, ':': {},
	'\'': {}, '"': {},
	'«': {}, '»': {}, '„': {}, '“': {}, '”': {}, '‘': {}, '’': {},
	'(': {}, ')': {}, '[': {}, ']': {}, '{': {}, '}': {},
	'-': {}, '—': {}, '–': {}, '…': {},
}

func normalise(s string) string {
	s = strings.ToLower(s)
	var b strings.Builder
	for _, r := range s {
		if _, drop := punctuationToStrip[r]; drop {
			continue
		}
		if unicode.IsSpace(r) {
			continue
		}
		b.WriteRune(r)
	}
	return strings.TrimSpace(b.String())
}

func evenDistribution(tokens []callerToken, totalDurationSec float64) []types.WordTiming {
	slot := 0.0
	if totalDurationSec > 0 {
		slot = totalDurationSec / float64(len(tokens))
	}
	out := make([]types.WordTiming, len(tokens))
	for i, t := range tokens {
		out[i] = types.WordTiming{
			Word:  t.surface,
			Start: float64(i) * slot,
			End:   float64(i+1) * slot,
		}
	}
	return out
}

// lcsPairs returns the matched index pairs of a Longest Common
// Subsequence between a and b. O(n*m) time and space. Mirrors the JS
// implementation's tie-break (prefer dropping from `a` when scores
// tie).
func lcsPairs(a, b []string) [][2]int {
	n := len(a)
	m := len(b)
	if n == 0 || m == 0 {
		return nil
	}
	dp := make([][]uint16, n+1)
	for i := range dp {
		dp[i] = make([]uint16, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if a[i] == b[j] {
				dp[i][j] = dp[i+1][j+1] + 1
			} else if dp[i+1][j] >= dp[i][j+1] {
				dp[i][j] = dp[i+1][j]
			} else {
				dp[i][j] = dp[i][j+1]
			}
		}
	}
	var pairs [][2]int
	i, j := 0, 0
	for i < n && j < m {
		if a[i] == b[j] {
			pairs = append(pairs, [2]int{i, j})
			i++
			j++
		} else if dp[i+1][j] >= dp[i][j+1] {
			i++
		} else {
			j++
		}
	}
	return pairs
}
