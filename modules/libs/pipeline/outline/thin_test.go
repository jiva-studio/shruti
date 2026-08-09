package outline

import "testing"

func e(start int64) Entry { return Entry{Title: "h", Start: start, End: start} }

func TestThinChapters_MinGap(t *testing.T) {
	// Headings every 15s over 24 min → the gap clamps at 3 min: 0, 180s, …, 1260s.
	var in []Entry
	for s := int64(0); s < 1_440_000; s += 15_000 {
		in = append(in, e(s))
	}
	out := thinChapters(in, 1_440_000)
	if len(out) != 8 {
		t.Fatalf("min-gap thinning = %d chapters, want 8", len(out))
	}
	for i := 1; i < len(out); i++ {
		if out[i].Start-out[i-1].Start < chapterGapMs(1_440_000) {
			t.Fatalf("chapters %d and %d closer than min gap", i-1, i)
		}
	}
	// Spans re-derived: each end = next start, last = duration.
	if out[0].End != out[1].Start || out[len(out)-1].End != 1_440_000 {
		t.Fatalf("spans not re-derived: %+v", out)
	}
}

func TestThinChapters_NoCap(t *testing.T) {
	// 30 well-spaced headings (5 min apart) all survive: the count follows the
	// lecture, and a two-hour talk is allowed more chapters than a short one.
	var in []Entry
	for i := int64(0); i < 30; i++ {
		in = append(in, e(i*300_000))
	}
	out := thinChapters(in, 30*300_000)
	if len(out) != 30 {
		t.Fatalf("well-spaced headings = %d chapters, want 30", len(out))
	}
	if out[0].Start != 0 {
		t.Fatalf("first chapter must be kept, got start %d", out[0].Start)
	}
}

func TestChapterGap_ScalesWithLecture(t *testing.T) {
	// A short talk must not be cut to two chapters by a gap sized for an hour.
	if g := chapterGapMs(9 * 60_000); g != 9*60_000/8 {
		t.Fatalf("9-minute lecture gap = %ds, want %ds", g/1000, 9*60/8)
	}
	// Below the floor the shortest talks keep a minute between chapters.
	if g := chapterGapMs(4 * 60_000); g != 60_000 {
		t.Fatalf("4-minute lecture gap = %ds, want 60s", g/1000)
	}
	// From 24 minutes up the ceiling takes over, so every longer lecture keeps
	// the three-minute spacing the corpus was measured with.
	if g := chapterGapMs(30 * 60_000); g != 180_000 {
		t.Fatalf("30-minute lecture gap = %ds, want 180s", g/1000)
	}
	if g := chapterGapMs(120 * 60_000); g != 180_000 {
		t.Fatalf("2-hour lecture gap = %ds, want 180s", g/1000)
	}
}
