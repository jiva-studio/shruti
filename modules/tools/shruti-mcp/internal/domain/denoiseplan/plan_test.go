package denoiseplan

import (
	"testing"

	"github.com/jiva-studio/shruti/pipeline/transcript"
)

// speechSegs returns n confident-English segments starting at startMs, 3s each.
func speechSegs(startMs int64, n int) []transcript.RawSegment {
	out := make([]transcript.RawSegment, 0, n)
	t := startMs
	for i := 0; i < n; i++ {
		out = append(out, transcript.RawSegment{
			Start: t, End: t + 3000,
			Text:       "so we are discussing the topic of the soul and the body",
			Confidence: 0.95,
		})
		t += 3000
	}
	return out
}

func TestBuild_KirtanIntro(t *testing.T) {
	segs := []transcript.RawSegment{
		{Start: 0, End: 8000, Text: "Hare Krishna Hare Krishna Krishna Krishna", Confidence: 0.60},
		{Start: 8000, End: 16000, Text: "Hare Rama Hare Rama Rama Rama", Confidence: 0.55},
		{Start: 16000, End: 25000, Text: "Krishna Krishna Hare Hare", Confidence: 0.62},
	}
	segs = append(segs, speechSegs(25000, 20)...) // body 25s..85s
	durationMs := int64(86000)

	plan := Build(segs, durationMs)
	if len(plan) != 2 {
		t.Fatalf("want 2 segments, got %d: %+v", len(plan), plan)
	}
	if plan[0].Strategy != StrategyAfftdn || plan[0].StartMs != 0 || plan[0].EndMs != 25000 {
		t.Errorf("segment0 = %+v, want afftdn [0,25000)", plan[0])
	}
	if plan[0].NR == nil || *plan[0].NR != kirtanNR {
		t.Errorf("segment0 NR = %v, want %v", plan[0].NR, kirtanNR)
	}
	if plan[1].Strategy != StrategyDeepFilterNet || plan[1].StartMs != 25000 || plan[1].EndMs != durationMs {
		t.Errorf("segment1 = %+v, want deepfilternet [25000,%d)", plan[1], durationMs)
	}
}

func TestBuild_NoKirtan(t *testing.T) {
	// Speech from the very start, no chant → no plan (caller denoises whole).
	plan := Build(speechSegs(0, 20), 60000)
	if plan != nil {
		t.Errorf("want nil plan for all-speech track, got %+v", plan)
	}
}

func TestBuild_NotARealLecture(t *testing.T) {
	// Too few confident-English segments → nil (separate policy, not kirtan).
	plan := Build(speechSegs(0, 10), 30000)
	if plan != nil {
		t.Errorf("want nil for <15 confident-English segs, got %+v", plan)
	}
}

func TestBuild_InternalKirtan(t *testing.T) {
	var segs []transcript.RawSegment
	segs = append(segs, speechSegs(0, 12)...) // body 0..36s
	// 50s of sung kirtan mid-talk (bordered by speech)
	segs = append(segs,
		transcript.RawSegment{Start: 36000, End: 61000, Text: "Hare Krishna Krishna Krishna Hare Hare", Confidence: 0.6},
		transcript.RawSegment{Start: 61000, End: 86000, Text: "Hare Rama Rama Rama Hare Hare", Confidence: 0.58},
	)
	segs = append(segs, speechSegs(86000, 12)...) // body resumes 86s..122s
	durationMs := int64(122000)

	plan := Build(segs, durationMs)
	if len(plan) != 3 {
		t.Fatalf("want 3 segments, got %d: %+v", len(plan), plan)
	}
	if plan[1].Strategy != StrategyAfftdn || plan[1].StartMs != 36000 || plan[1].EndMs != 86000 {
		t.Errorf("middle segment = %+v, want afftdn [36000,86000)", plan[1])
	}
	if plan[0].Strategy != StrategyDeepFilterNet || plan[2].Strategy != StrategyDeepFilterNet {
		t.Errorf("body segments should be deepfilternet: %+v", plan)
	}
	// contiguous partition covering [0, durationMs)
	if plan[0].StartMs != 0 || plan[len(plan)-1].EndMs != durationMs {
		t.Errorf("plan must cover [0,%d): %+v", durationMs, plan)
	}
}
