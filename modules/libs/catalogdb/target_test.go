package catalogdb

import "testing"

func TestNormalizeTokens(t *testing.T) {
	for in, want := range map[string]string{
		"2.13":        "2.13",
		" 02.013 ":    "2.13",
		"16.07":       "16.7",
		"1.16–18":     "1.16-18",
		"1.16—1.18":   "1.16-1.18",
		"Madhya 8.01": "Madhya 8.1",
		"0":           "0",
		"":            "",
	} {
		if got := NormalizeTokens(in); got != want {
			t.Errorf("NormalizeTokens(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestTitleTargetRoundTrips(t *testing.T) {
	got, err := ParseTitleTarget("source_sb/05.005")
	if err != nil {
		t.Fatal(err)
	}
	if got.SourceID != "source_sb" || got.Tokens != "5.5" || got.String() != "source_sb/5.5" {
		t.Fatalf("parsed %+v (%s)", got, got)
	}
	for _, bad := range []string{"", "source_sb", "/5.5", "source_sb/", " /5"} {
		if _, err := ParseTitleTarget(bad); err == nil {
			t.Errorf("ParseTitleTarget(%q) accepted a malformed target", bad)
		}
	}
	if _, err := NewTitleTarget("a/b", "1"); err == nil {
		t.Error("a source id with '/' would not parse back")
	}
}

func TestTrackTargetRoundTrips(t *testing.T) {
	got, err := ParseTrackTarget("track_abc@1500-2500")
	if err != nil {
		t.Fatal(err)
	}
	if got != (TrackTarget{TrackID: "track_abc", StartMs: 1500, EndMs: 2500}) || got.String() != "track_abc@1500-2500" {
		t.Fatalf("parsed %+v", got)
	}
	for _, bad := range []string{
		"track_abc", "@1-2", "track_abc@", "track_abc@1", "track_abc@x-2",
		"track_abc@1-x", "track_abc@5-4", "track_abc@-1-4", "a@b@1-2",
	} {
		if _, err := ParseTrackTarget(bad); err == nil {
			t.Errorf("ParseTrackTarget(%q) accepted a malformed target", bad)
		}
	}
}
