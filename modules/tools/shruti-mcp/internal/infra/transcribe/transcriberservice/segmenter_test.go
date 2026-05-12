package transcriberservice

import (
	"strings"
	"testing"
)

func TestSegmenter_Empty(t *testing.T) {
	if got := segmentWordTimings(nil); got != nil {
		t.Fatalf("nil input should produce nil, got %#v", got)
	}
	if got := segmentWordTimings([]WordTiming{}); got != nil {
		t.Fatalf("empty input should produce nil, got %#v", got)
	}
}

func TestSegmenter_SequentialIdxAndMs(t *testing.T) {
	// Two segments: first cut by punctuation, second flushed on last.
	words := []WordTiming{
		{Word: "Hello", StartTime: 0.10, EndTime: 0.50},
		{Word: "world.", StartTime: 0.50, EndTime: 1.00},
		{Word: "Foo", StartTime: 1.00, EndTime: 1.40},
		{Word: "bar", StartTime: 1.40, EndTime: 1.80},
	}
	got := segmentWordTimings(words)
	if len(got) != 2 {
		t.Fatalf("expected 2 segments, got %d", len(got))
	}
	if got[0].Idx != 0 || got[1].Idx != 1 {
		t.Errorf("idx mismatch: %d / %d", got[0].Idx, got[1].Idx)
	}
	// Segment 0 = "Hello world.", 100..1000 ms
	if got[0].Start != 100 || got[0].End != 1000 {
		t.Errorf("seg0 timing %d..%d, want 100..1000", got[0].Start, got[0].End)
	}
	if got[0].Text != "Hello world." {
		t.Errorf("seg0 text %q", got[0].Text)
	}
	// Segment 1 = "Foo bar", 1000..1800
	if got[1].Start != 1000 || got[1].End != 1800 {
		t.Errorf("seg1 timing %d..%d, want 1000..1800", got[1].Start, got[1].End)
	}
	if got[1].Text != "Foo bar" {
		t.Errorf("seg1 text %q", got[1].Text)
	}
}

func TestSegmenter_5sWindowCut(t *testing.T) {
	// 8-second monologue with no punctuation; should cut once near 5s.
	var words []WordTiming
	for i := 0; i < 8; i++ {
		words = append(words, WordTiming{
			Word:      "word",
			StartTime: float64(i) + 0.0,
			EndTime:   float64(i) + 0.99,
		})
	}
	got := segmentWordTimings(words)
	if len(got) != 2 {
		t.Fatalf("expected 2 segments from 8s no-punct stream, got %d", len(got))
	}
	// First segment must end on or after 5_000 ms.
	if got[0].End < 5_000 {
		t.Errorf("first segment ended at %d ms, want >= 5000", got[0].End)
	}
}

func TestSegmenter_30WordCut(t *testing.T) {
	// 35 short adjacent words, no punctuation, well under 5s each.
	var words []WordTiming
	for i := 0; i < 35; i++ {
		words = append(words, WordTiming{
			Word:      "w",
			StartTime: float64(i) * 0.05,
			EndTime:   float64(i)*0.05 + 0.04,
		})
	}
	got := segmentWordTimings(words)
	if len(got) != 2 {
		t.Fatalf("expected 2 segments from 35 short words, got %d", len(got))
	}
	if strings.Count(got[0].Text, " ")+1 != 30 {
		t.Errorf("first segment word count = %d, want 30",
			strings.Count(got[0].Text, " ")+1)
	}
}

func TestSegmenter_PunctuationCutsRepeatedly(t *testing.T) {
	// Three sentences in 4 seconds → three segments.
	words := []WordTiming{
		{Word: "Hi.", StartTime: 0, EndTime: 1},
		{Word: "Yes?", StartTime: 1, EndTime: 2},
		{Word: "Done!", StartTime: 2, EndTime: 3},
	}
	got := segmentWordTimings(words)
	if len(got) != 3 {
		t.Fatalf("expected 3 segments, got %d (%v)", len(got), got)
	}
	for i, s := range got {
		if s.Idx != i {
			t.Errorf("seg %d idx=%d", i, s.Idx)
		}
	}
}

func TestSegmenter_TrimsWhitespace(t *testing.T) {
	words := []WordTiming{
		{Word: "  hello", StartTime: 0, EndTime: 0.5},
		{Word: "world  ", StartTime: 0.5, EndTime: 1.0},
	}
	got := segmentWordTimings(words)
	if len(got) != 1 {
		t.Fatalf("expected 1 segment, got %d", len(got))
	}
	if got[0].Text != "hello world" {
		t.Errorf("text %q, want 'hello world'", got[0].Text)
	}
}

func TestSegmenter_AveragesConfidence(t *testing.T) {
	// Three sentences cut by punctuation. Each carries a distinct
	// constant confidence so we can spot a bug that mixes seg buckets.
	words := []WordTiming{
		{Word: "Aa", StartTime: 0, EndTime: 0.4, Confidence: 0.9},
		{Word: "bb.", StartTime: 0.4, EndTime: 0.8, Confidence: 0.9},
		{Word: "Cc", StartTime: 0.8, EndTime: 1.2, Confidence: 0.5},
		{Word: "dd?", StartTime: 1.2, EndTime: 1.6, Confidence: 0.5},
		{Word: "Ee", StartTime: 1.6, EndTime: 2.0, Confidence: 0.1},
		{Word: "ff!", StartTime: 2.0, EndTime: 2.4, Confidence: 0.3},
	}
	got := segmentWordTimings(words)
	if len(got) != 3 {
		t.Fatalf("expected 3 segments, got %d", len(got))
	}
	cases := []float64{0.9, 0.5, 0.2}
	for i, want := range cases {
		if got[i].Confidence < want-1e-9 || got[i].Confidence > want+1e-9 {
			t.Errorf("seg %d confidence = %.4f, want %.4f", i, got[i].Confidence, want)
		}
	}
}

func TestSegmenter_ZeroConfidenceWhenAbsent(t *testing.T) {
	// Provider didn't supply per-word confidence (all zero) → segment
	// confidence stays at the JSON-zero. We don't fabricate a 1.0.
	words := []WordTiming{
		{Word: "Hi.", StartTime: 0, EndTime: 0.5},
	}
	got := segmentWordTimings(words)
	if len(got) != 1 {
		t.Fatalf("expected 1 segment, got %d", len(got))
	}
	if got[0].Confidence != 0 {
		t.Errorf("zero-input confidence = %v, want 0", got[0].Confidence)
	}
}
