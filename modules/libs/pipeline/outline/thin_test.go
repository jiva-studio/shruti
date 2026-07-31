package outline

import "testing"

func e(start int64) Entry { return Entry{Title: "h", Start: start, End: start} }

func TestThinChapters_MinGap(t *testing.T) {
	// Headings every 15s over 3 min → dropped to one per 60s.
	var in []Entry
	for s := int64(0); s < 180_000; s += 15_000 {
		in = append(in, e(s))
	}
	out := thinChapters(in, 180_000)
	if len(out) != 3 { // 0s, 60s, 120s (135/150/165s within 60s of 120 dropped... actually 0,60,120 then 180 is end)
		t.Fatalf("min-gap thinning = %d chapters, want 3", len(out))
	}
	for i := 1; i < len(out); i++ {
		if out[i].Start-out[i-1].Start < minChapterGapMs {
			t.Fatalf("chapters %d and %d closer than min gap", i-1, i)
		}
	}
	// Spans re-derived: each end = next start, last = duration.
	if out[0].End != out[1].Start || out[len(out)-1].End != 180_000 {
		t.Fatalf("spans not re-derived: %+v", out)
	}
}

func TestThinChapters_Cap(t *testing.T) {
	// 30 well-spaced headings (5 min apart) → capped at maxCoarseChapters.
	var in []Entry
	for i := int64(0); i < 30; i++ {
		in = append(in, e(i*300_000))
	}
	out := thinChapters(in, 30*300_000)
	if len(out) != maxCoarseChapters {
		t.Fatalf("cap = %d, want %d", len(out), maxCoarseChapters)
	}
	if out[0].Start != 0 {
		t.Fatalf("first chapter must be kept, got start %d", out[0].Start)
	}
}
