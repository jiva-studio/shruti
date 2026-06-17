// Package denoiseplan turns a raw transcript into a splice plan for the
// denoiser: a contiguous partition of the timeline where sung kirtan / recited
// Sanskrit regions are cleaned with afftdn (which keeps the singing) and the
// speech body with deepfilternet (a speech model that would otherwise mangle
// the singing). Mirrors the corpus-analysis heuristic, ported to Go so
// track.audio.denoise builds the plan from the existing EN transcript.
package denoiseplan

import (
	"regexp"
	"sort"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/transcript"
)

// Strategy names understood by audio-denoiser/denoise_mp3.py --plan.
const (
	StrategyAfftdn        = "afftdn"
	StrategyDeepFilterNet = "deepfilternet"
)

// Segment is one slice of a splice plan: [StartMs, EndMs) cleaned with Strategy.
type Segment struct {
	StartMs  int64
	EndMs    int64
	Strategy string
	NR       *float64 // afftdn override; nil = script default
}

// CrossfadeMs is the seam crossfade paired with every built plan.
const CrossfadeMs = 120

const (
	confHi        = 0.85  // confident segment
	confLo        = 0.70  // below = suspect (sung / garbled)
	edgeMinMs     = 20000 // min edge-region duration to bother protecting
	internalMinMs = 40000 // min mid-talk kirtan duration
	bodyMinConf   = 0.80  // median body confidence gate (real lecture)
	minConfEnSegs = 15    // min confident-English segments (real lecture)
	kirtanNR      = 8.0   // gentle afftdn over kirtan (vs script default 12)
)

var (
	chantRe  = regexp.MustCompile(`(?i)\b(hare|krishna|krsna|rama|govinda|gopala|gauranga|gaura|nitai|nityananda|jaya|jai|haribol|hari|radha|radhe|narayana|kesava|madhava|mukunda|caitanya|chaitanya|gopi|nrsimha|nrisimha|gadadhara|advaita|srivasa|gauri|nimai|vrndavan|vrindavan)\b`)
	enStopRe = regexp.MustCompile(`(?i)\b(the|and|is|are|that|this|you|we|so|of|to|in|it|he|she|they|was|were|have|has|will|would|because|therefore|now|here|there|what|when|but|not|do|can|if|as|for|on|at|with|my|your|our|all|one|like)\b`)
)

func engScore(t string) int  { return len(enStopRe.FindAllString(t, -1)) }
func hasChant(t string) bool { return chantRe.MatchString(t) }

func isEnglish(s transcript.RawSegment) bool {
	return s.Confidence >= confHi && engScore(s.Text) >= 2
}

func nonSpeech(s transcript.RawSegment) bool {
	return s.Confidence < confLo || (hasChant(s.Text) && engScore(s.Text) <= 1)
}

// Build returns a contiguous splice plan (afftdn over kirtan/recitation,
// deepfilternet over speech) covering [0, durationMs), or nil when the track
// has no protectable regions — in which case the caller denoises whole-file as
// usual. Tracks that aren't real lectures (too few confident English segments,
// or a low-confidence body throughout) also return nil: they're a separate
// policy question, not kirtan edges.
func Build(segs []transcript.RawSegment, durationMs int64) []Segment {
	if len(segs) < 8 || durationMs <= 0 {
		return nil
	}

	var confEn []int
	for i := range segs {
		if isEnglish(segs[i]) {
			confEn = append(confEn, i)
		}
	}
	if len(confEn) < minConfEnSegs {
		return nil
	}
	firstEn, lastEn := confEn[0], confEn[len(confEn)-1]

	body := make([]float64, 0, lastEn-firstEn+1)
	for _, s := range segs[firstEn : lastEn+1] {
		body = append(body, s.Confidence)
	}
	if median(body) < bodyMinConf {
		return nil
	}

	type region struct{ start, end int64 }
	var regions []region
	for i := 0; i < len(segs); {
		if !nonSpeech(segs[i]) {
			i++
			continue
		}
		a := i
		for i < len(segs) && nonSpeech(segs[i]) {
			i++
		}
		b := i - 1

		chant := 0
		for _, s := range segs[a : b+1] {
			if hasChant(s.Text) {
				chant++
			}
		}
		switch {
		case a <= firstEn: // run touches the start → protect the lead-in
			if end := segs[firstEn].Start; end >= edgeMinMs && chant >= 1 {
				regions = append(regions, region{0, end})
			}
		case b >= lastEn: // run touches the end → protect the tail
			if start := segs[lastEn].End; durationMs-start >= edgeMinMs && chant >= 1 {
				regions = append(regions, region{start, durationMs})
			}
		default: // mid-talk kirtan, bordered by speech
			if start, end := segs[a].Start, segs[b].End; end-start >= internalMinMs && chant >= 2 {
				regions = append(regions, region{start, end})
			}
		}
	}
	if len(regions) == 0 {
		return nil
	}
	sort.Slice(regions, func(i, j int) bool { return regions[i].start < regions[j].start })

	// Stitch into a full partition: afftdn over each region, deepfilternet in
	// the gaps between them.
	var plan []Segment
	var cursor int64
	for _, r := range regions {
		start, end := r.start, r.end
		if start < cursor { // clamp any overlap from edge/internal collision
			start = cursor
		}
		if end <= start {
			continue
		}
		if start > cursor {
			plan = append(plan, Segment{StartMs: cursor, EndMs: start, Strategy: StrategyDeepFilterNet})
		}
		nr := kirtanNR
		plan = append(plan, Segment{StartMs: start, EndMs: end, Strategy: StrategyAfftdn, NR: &nr})
		cursor = end
	}
	if cursor < durationMs {
		plan = append(plan, Segment{StartMs: cursor, EndMs: durationMs, Strategy: StrategyDeepFilterNet})
	}
	return plan
}

func median(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	s := append([]float64(nil), xs...)
	sort.Float64s(s)
	return s[len(s)/2]
}
