package align

import (
	"testing"

	"github.com/akdasa-studios/shruti-share-video/internal/pipeline/transcript"
)

// Sanity test: the easy path where caller and whisper agree word-for-word.
// Whisper timings should be adopted verbatim.
func TestForceAlign_ExactMatch(t *testing.T) {
	caller := "Hello world this is a test"
	whisper := []transcript.Word{
		{Word: "hello", Start: 0.0, End: 0.5},
		{Word: "world", Start: 0.5, End: 1.0},
		{Word: "this", Start: 1.0, End: 1.3},
		{Word: "is", Start: 1.3, End: 1.5},
		{Word: "a", Start: 1.5, End: 1.6},
		{Word: "test", Start: 1.6, End: 2.0},
	}
	got := ForceAlign(caller, whisper, 2.0)
	if len(got) != 6 {
		t.Fatalf("want 6 timings, got %d", len(got))
	}
	if got[0].Word != "Hello" || got[5].Word != "test" {
		t.Fatalf("surface forms not preserved: %+v", got)
	}
	if got[5].Start != 1.6 || got[5].End != 2.0 {
		t.Fatalf("whisper timings not adopted: %+v", got[5])
	}
}

// Punctuation in caller should be preserved in surface form but
// stripped for matching, so anchors still hit.
func TestForceAlign_PunctuationAnchors(t *testing.T) {
	caller := "Hello, world! This is a test."
	whisper := []transcript.Word{
		{Word: "hello", Start: 0.0, End: 0.5},
		{Word: "world", Start: 0.5, End: 1.0},
		{Word: "this", Start: 1.0, End: 1.3},
		{Word: "is", Start: 1.3, End: 1.5},
		{Word: "a", Start: 1.5, End: 1.6},
		{Word: "test", Start: 1.6, End: 2.0},
	}
	got := ForceAlign(caller, whisper, 2.0)
	if len(got) != 6 {
		t.Fatalf("want 6 timings, got %d", len(got))
	}
	if got[0].Word != "Hello," {
		t.Fatalf("comma should be kept in surface form: %q", got[0].Word)
	}
	if got[0].Start != 0.0 || got[0].End != 0.5 {
		t.Fatalf("anchor through punctuation lost: %+v", got[0])
	}
}

// Drastic size mismatch (caller 6, whisper 1) → even distribution
// across the full duration.
func TestForceAlign_SizeMismatch(t *testing.T) {
	caller := "one two three four five six"
	whisper := []transcript.Word{
		{Word: "one", Start: 0.0, End: 0.5},
	}
	got := ForceAlign(caller, whisper, 6.0)
	if len(got) != 6 {
		t.Fatalf("want 6 timings, got %d", len(got))
	}
	if got[0].Start != 0.0 || got[0].End != 1.0 {
		t.Fatalf("even-distribution slot 0 wrong: %+v", got[0])
	}
	if got[5].Start != 5.0 || got[5].End != 6.0 {
		t.Fatalf("even-distribution slot 5 wrong: %+v", got[5])
	}
}

// One unanchored caller word between two anchors should land between
// the surrounding timings.
func TestForceAlign_InterpolateBetweenAnchors(t *testing.T) {
	caller := "alpha bravo charlie"
	// Whisper hears "alpha" and "charlie"; "bravo" misrecognised as "xxx".
	whisper := []transcript.Word{
		{Word: "alpha", Start: 0.0, End: 1.0},
		{Word: "xxx", Start: 1.0, End: 2.0},
		{Word: "charlie", Start: 2.0, End: 3.0},
	}
	got := ForceAlign(caller, whisper, 3.0)
	if len(got) != 3 {
		t.Fatalf("want 3 timings, got %d", len(got))
	}
	if got[0].Start != 0.0 || got[0].End != 1.0 {
		t.Fatalf("alpha anchor wrong: %+v", got[0])
	}
	if got[2].Start != 2.0 || got[2].End != 3.0 {
		t.Fatalf("charlie anchor wrong: %+v", got[2])
	}
	// bravo should sit between 1.0 and 2.0.
	if got[1].Start < 1.0 || got[1].End > 2.0+0.001 {
		t.Fatalf("bravo interpolation out of range: %+v", got[1])
	}
}

// Slide grouping should respect the maxCharsPerSlide cap and never
// drop words; counts must match.
func TestWordsToSlides_RespectsCap(t *testing.T) {
	got := ForceAlign(
		"alpha bravo charlie delta echo foxtrot golf",
		[]transcript.Word{
			{Word: "alpha", Start: 0.0, End: 0.5},
			{Word: "bravo", Start: 0.5, End: 1.0},
			{Word: "charlie", Start: 1.0, End: 1.5},
			{Word: "delta", Start: 1.5, End: 2.0},
			{Word: "echo", Start: 2.0, End: 2.5},
			{Word: "foxtrot", Start: 2.5, End: 3.0},
			{Word: "golf", Start: 3.0, End: 3.5},
		},
		3.5,
	)
	slides := WordsToSlides(got, 20)
	if len(slides) == 0 {
		t.Fatal("want at least one slide")
	}
	total := 0
	for _, s := range slides {
		if len(s.Text) > 20 && len(s.Words) > 1 {
			t.Errorf("slide exceeded 20 chars: %q", s.Text)
		}
		total += len(s.Words)
	}
	if total != 7 {
		t.Fatalf("words lost during grouping: got %d/7", total)
	}
}
