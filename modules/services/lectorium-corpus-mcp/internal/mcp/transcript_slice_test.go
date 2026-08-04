package mcpsrv

import "testing"

func doc() *transcriptDoc {
	return &transcriptDoc{Blocks: []transcriptBlock{
		{Type: "sentence", Start: 0, End: 5000, Text: "before"},
		{Type: "sentence", Start: 9000, End: 11000, Text: "straddles the start"},
		{Type: "sentence", Start: 11000, End: 14000, Text: "  inside  "},
		{Type: "sentence", Start: 14000, End: 16000, Text: ""},
		{Type: "sentence", Start: 19000, End: 21000, Text: "straddles the end"},
		{Type: "sentence", Start: 30000, End: 33000, Text: "after"},
	}}
}

func TestSliceTranscriptKeepsOnlyTheWindow(t *testing.T) {
	got := sliceTranscript(doc(), 10000, 20000)
	want := []string{"inside"}
	if len(got) != len(want) {
		t.Fatalf("got %d blocks, want %d: %+v", len(got), len(want), got)
	}
	for i, w := range want {
		if got[i].Text != w {
			t.Errorf("block %d = %q, want %q", i, got[i].Text, w)
		}
	}
}

func TestSliceTranscriptEmptyWindow(t *testing.T) {
	if got := sliceTranscript(doc(), 22000, 29000); len(got) != 0 {
		t.Fatalf("expected no blocks between two sentences, got %+v", got)
	}
}

// A window landing inside one sentence hears only part of it, so it yields no
// text rather than a sentence the listener never hears in full.
func TestSliceTranscriptDropsPartiallyAudibleSentences(t *testing.T) {
	if got := sliceTranscript(doc(), 12000, 13000); len(got) != 0 {
		t.Fatalf("expected nothing for a window inside a sentence, got %+v", got)
	}
}

func TestSliceTranscriptCapsLength(t *testing.T) {
	long := &transcriptDoc{}
	for i := 0; i < transcriptMaxBlocks*2; i++ {
		long.Blocks = append(long.Blocks, transcriptBlock{Start: i * 100, End: i*100 + 100, Text: "x"})
	}
	if got := sliceTranscript(long, 0, 1_000_000); len(got) != transcriptMaxBlocks {
		t.Fatalf("got %d blocks, want the %d cap", len(got), transcriptMaxBlocks)
	}
}
