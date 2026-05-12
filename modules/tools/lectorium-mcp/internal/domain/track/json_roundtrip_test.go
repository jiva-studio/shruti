package track

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

// TestMetadataJSONRoundTrip pins Marshal/Unmarshal symmetry: encode a
// constructed Metadata, decode the bytes back, the value must equal the
// original. Defends against drift between the two methods (rename a
// field on one side, forget the other — silent data loss).
func TestMetadataJSONRoundTrip(t *testing.T) {
	d, _ := time.Parse("2006-01-02", "1974-10-20")
	cases := []struct {
		name string
		spec MetadataSpec
	}{
		{
			name: "full",
			spec: MetadataSpec{
				Title:           "BG 10.5 — Bombay",
				Date:            &d,
				AuthorRaw:       "A.C. Bhaktivedanta Swami Prabhupada",
				LocationRaw:     "Bombay",
				TitleIsFallback: false,
				Languages:       []string{"en", "ru"},
				References: []RefRaw{
					{SourceCode: "BG", Tokens: "10.5"},
					{SourceCode: "BG", Tokens: "10.6"},
				},
				KindTag: "morning_walk",
			},
		},
		{
			name: "minimal",
			spec: MetadataSpec{Title: "x", TitleIsFallback: true},
		},
		{
			name: "no date",
			spec: MetadataSpec{Title: "y", Languages: []string{"en"}},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			orig, err := NewMetadata(c.spec)
			if err != nil {
				t.Fatalf("NewMetadata: %v", err)
			}
			body, err := json.Marshal(orig)
			if err != nil {
				t.Fatalf("Marshal: %v", err)
			}
			var got Metadata
			if err := json.Unmarshal(body, &got); err != nil {
				t.Fatalf("Unmarshal: %v", err)
			}
			if !metadataEqual(orig, got) {
				t.Errorf("round-trip mismatch:\n  orig=%+v\n  got =%+v\n  json=%s", orig, got, body)
			}
		})
	}
}

// TestMetadataJSONShape pins the on-disk wire shape. A schema change
// here is a breaking change for every meta.json sidecar already on disk
// and for every stage payload already in the lake registry — surface
// it loudly via a failing test rather than silently breaking deserialization.
func TestMetadataJSONShape(t *testing.T) {
	d, _ := time.Parse("2006-01-02", "1974-10-20")
	m, err := NewMetadata(MetadataSpec{
		Title:       "x",
		Date:        &d,
		AuthorRaw:   "Prabhupada",
		LocationRaw: "Bombay",
		Languages:   []string{"en"},
		KindTag:     "morning_walk",
		References:  []RefRaw{{SourceCode: "BG", Tokens: "10.5"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(m)
	// Decode into a generic map so we can pin keys without coupling
	// to metadataJSON.
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		t.Fatal(err)
	}
	wantKeys := []string{"title", "date", "author_raw", "location_raw", "languages", "references", "kind_tag"}
	for _, k := range wantKeys {
		if _, ok := raw[k]; !ok {
			t.Errorf("expected key %q in JSON, got: %s", k, body)
		}
	}
	if got := raw["date"]; got != "1974-10-20" {
		t.Errorf("date = %v, want 1974-10-20", got)
	}
}

func TestAudioJSONRoundTrip(t *testing.T) {
	orig, err := NewAudio(AudioSpec{
		TrackId:        "track_abc",
		OriginalPath:   "out/artifacts/tracks/track_abc/audio/source.mp3",
		NormalizedPath: "out/public/tracks/track_abc/audio/original.mp3",
		LoudnessLUFS:   -16.5,
		Bitrate:        128,
		DurationMs:     3_540_000,
		SizeBytes:      56_640_000,
		Channels:       2,
		SampleRate:     44100,
	})
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(orig)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var got Audio
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if !reflect.DeepEqual(orig, got) {
		t.Errorf("round-trip mismatch:\n  orig=%+v\n  got =%+v\n  json=%s", orig, got, body)
	}
}

// metadataEqual compares via accessors — DeepEqual would fail when one
// side has a nil slice and the other has an empty (allocated) one,
// which JSON omitempty produces.
func metadataEqual(a, b Metadata) bool {
	if a.Title() != b.Title() {
		return false
	}
	if a.AuthorRaw() != b.AuthorRaw() || a.LocationRaw() != b.LocationRaw() {
		return false
	}
	if a.TitleIsFallback() != b.TitleIsFallback() || a.KindTag() != b.KindTag() {
		return false
	}
	if !slicesEqual(a.Languages(), b.Languages()) {
		return false
	}
	if !refsEqual(a.References(), b.References()) {
		return false
	}
	ad, bd := a.Date(), b.Date()
	if (ad == nil) != (bd == nil) {
		return false
	}
	if ad != nil && !ad.Equal(*bd) {
		return false
	}
	return true
}

func slicesEqual(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func refsEqual(a, b []RefRaw) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
