package track

import (
	"strings"
	"testing"
	"time"
)

func TestNewMetadataValidation(t *testing.T) {
	now := time.Now()
	cases := []struct {
		name    string
		spec    MetadataSpec
		wantErr string // substring; "" means must succeed
	}{
		{"happy", MetadataSpec{Title: "Lecture on BG 10.5", Date: &now}, ""},
		{"empty title", MetadataSpec{Title: ""}, "title"},
		{"whitespace title", MetadataSpec{Title: "   "}, "title"},
		{"unknown kind_tag", MetadataSpec{Title: "x", KindTag: "garbage"}, "kind_tag"},
		{"good kind_tag", MetadataSpec{Title: "x", KindTag: "morning_walk"}, ""},
		{"empty source_code", MetadataSpec{Title: "x", References: []RefRaw{{SourceCode: ""}}}, "source_code"},
		{"fallback title accepted", MetadataSpec{Title: "filename.mp3", TitleIsFallback: true}, ""},
		{"date may be nil at construction", MetadataSpec{Title: "x", Date: nil}, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := NewMetadata(c.spec)
			if c.wantErr == "" {
				if err != nil {
					t.Fatalf("expected nil, got %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), c.wantErr) {
				t.Fatalf("error %q must contain %q", err, c.wantErr)
			}
		})
	}
}

func TestMetadataMinimallyComplete(t *testing.T) {
	now := time.Now()
	// Only test states reachable through NewMetadata — the empty-title /
	// whitespace cases are caught earlier by the constructor and live in
	// TestNewMetadataValidation above.
	cases := []struct {
		name    string
		spec    MetadataSpec
		wantErr string
	}{
		{"happy", MetadataSpec{Title: "Lecture on BG 10.5", Date: &now}, ""},
		{"missing date", MetadataSpec{Title: "X"}, "date"},
		{"fallback title still passes", MetadataSpec{Title: "filename.mp3", Date: &now, TitleIsFallback: true}, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m, err := NewMetadata(c.spec)
			if err != nil {
				t.Fatalf("NewMetadata: %v", err)
			}
			err = m.MinimallyComplete()
			if c.wantErr == "" {
				if err != nil {
					t.Fatalf("expected nil, got %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), c.wantErr) {
				t.Fatalf("error %q must contain %q", err, c.wantErr)
			}
		})
	}
}

func TestMetadataAccessorsAreImmutable(t *testing.T) {
	now := time.Now()
	langs := []string{"en", "ru"}
	refs := []RefRaw{{SourceCode: "BG", Tokens: "10.5"}}
	m, err := NewMetadata(MetadataSpec{
		Title:      "x",
		Date:       &now,
		Languages:  langs,
		References: refs,
	})
	if err != nil {
		t.Fatal(err)
	}
	// Mutating the input slice must not reach into m.
	langs[0] = "fr"
	refs[0].SourceCode = "ZZ"
	if got := m.Languages(); got[0] != "en" {
		t.Errorf("Languages mutated through caller's slice: %v", got)
	}
	if got := m.References(); got[0].SourceCode != "BG" {
		t.Errorf("References mutated through caller's slice: %v", got)
	}
	// Mutating the returned slice must not reach back either.
	got := m.Languages()
	got[0] = "de"
	if again := m.Languages(); again[0] != "en" {
		t.Errorf("Languages getter shares storage: %v", again)
	}
	// Date pointer is also a copy.
	d1 := m.Date()
	*d1 = d1.Add(24 * time.Hour)
	d2 := m.Date()
	if d2.Equal(*d1) {
		t.Error("Date getter shares pointer with caller")
	}
}

func TestNewAudioValidation(t *testing.T) {
	good := AudioSpec{
		DurationMs: 1000, SizeBytes: 1024, Bitrate: 128,
		Channels: 2, SampleRate: 44100,
	}
	cases := []struct {
		name    string
		spec    AudioSpec
		wantErr string
	}{
		{"happy", good, ""},
		{"zero duration", mutateAudio(good, func(s *AudioSpec) { s.DurationMs = 0 }), "duration_ms"},
		{"negative duration", mutateAudio(good, func(s *AudioSpec) { s.DurationMs = -1 }), "duration_ms"},
		{"zero size", mutateAudio(good, func(s *AudioSpec) { s.SizeBytes = 0 }), "size_bytes"},
		{"zero bitrate", mutateAudio(good, func(s *AudioSpec) { s.Bitrate = 0 }), "bitrate"},
		{"odd channels", mutateAudio(good, func(s *AudioSpec) { s.Channels = 3 }), "channels"},
		{"zero channels", mutateAudio(good, func(s *AudioSpec) { s.Channels = 0 }), "channels"},
		{"zero sample_rate", mutateAudio(good, func(s *AudioSpec) { s.SampleRate = 0 }), "sample_rate"},
		{"5.1 channels accepted", mutateAudio(good, func(s *AudioSpec) { s.Channels = 6 }), ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := NewAudio(c.spec)
			if c.wantErr == "" {
				if err != nil {
					t.Fatalf("expected nil, got %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), c.wantErr) {
				t.Fatalf("error %q must contain %q", err, c.wantErr)
			}
		})
	}
}

func mutateAudio(in AudioSpec, mut func(*AudioSpec)) AudioSpec {
	out := in
	mut(&out)
	return out
}

func TestAudioIsPlayable(t *testing.T) {
	// IsPlayable now defends against direct unmarshal of a hostile JSON
	// blob; the constructor enforces the same invariant up front.
	good, err := NewAudio(AudioSpec{
		DurationMs: 1000, SizeBytes: 1024, Bitrate: 128,
		Channels: 2, SampleRate: 44100,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := good.IsPlayable(); err != nil {
		t.Errorf("expected nil for valid audio, got %v", err)
	}
	// Corrupt via unmarshal (no validation) — IsPlayable must reject.
	bad := Audio{}
	if err := bad.IsPlayable(); err == nil {
		t.Error("zero Audio should not be playable")
	}
}
