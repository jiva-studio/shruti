package transcript

import (
	"encoding/json"
	"reflect"
	"testing"
)

// TestRoundTripAllBlockKinds asserts wire-format compatibility with the TS
// Transcript schema. If this test breaks, the mobile app will refuse the JSON.
func TestRoundTripAllBlockKinds(t *testing.T) {
	cases := []Block{
		ParagraphBlock{Start: 0, End: 1500},
		SentenceBlock{Start: 1500, End: 3200, Text: "Hello world.", Speaker: "narrator"},
		SentenceBlock{Start: 3200, End: 5000, Text: "BG 10.5", Reference: &Reference{SourceID: "source_BhagavadGita", Tokens: []string{"10", "5"}}},
		VerseTextBlock{Start: 5000, End: 9000, Text: []string{"line1", "line2"}, Reference: &Reference{SourceID: "source_BhagavadGita", Tokens: []string{"10", "5"}}},
		VerseTranslationBlock{Start: 9000, End: 12000, Text: "translation here"},
	}
	for _, b := range cases {
		raw, err := MarshalBlock(b)
		if err != nil {
			t.Fatalf("marshal %T: %v", b, err)
		}
		got, err := UnmarshalBlock(raw)
		if err != nil {
			t.Fatalf("unmarshal %T: %v (wire=%s)", b, err, raw)
		}
		if !reflect.DeepEqual(got, b) {
			t.Fatalf("round-trip mismatch for %T:\n got:  %#v\n want: %#v\n wire: %s", b, got, b, raw)
		}
	}
}

func TestReviewedJSONRoundTrip(t *testing.T) {
	r := Reviewed{
		TrackID:  "track_aBC1234567890",
		Language: "ru",
		Version:  1,
		Blocks: []Block{
			ParagraphBlock{Start: 0, End: 100},
			SentenceBlock{Start: 100, End: 500, Text: "test"},
		},
	}
	raw, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	var got Reviewed
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v wire=%s", err, raw)
	}
	if !reflect.DeepEqual(got, r) {
		t.Fatalf("round-trip mismatch:\n got:  %#v\n want: %#v\n wire: %s", got, r, raw)
	}
}

func TestUnknownBlockTypeRejected(t *testing.T) {
	_, err := UnmarshalBlock(json.RawMessage(`{"type":"weird","start":0,"end":100}`))
	if err == nil {
		t.Fatal("expected error for unknown type")
	}
}

func TestSentenceWithoutOptionalFields(t *testing.T) {
	// Wire compatibility: TS optional fields use ?: — Go must omit them in JSON.
	raw, err := MarshalBlock(SentenceBlock{Start: 0, End: 100, Text: "x"})
	if err != nil {
		t.Fatal(err)
	}
	var asMap map[string]any
	if err := json.Unmarshal(raw, &asMap); err != nil {
		t.Fatal(err)
	}
	if _, exists := asMap["speaker"]; exists {
		t.Errorf("speaker must be omitted when empty; got %s", raw)
	}
	if _, exists := asMap["reference"]; exists {
		t.Errorf("reference must be omitted when nil; got %s", raw)
	}
}
