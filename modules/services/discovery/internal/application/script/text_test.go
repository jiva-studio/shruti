package script_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/jiva-studio/shruti/discovery/internal/application/script"
)

// Most archives publish words in one language and say so once, for the whole
// recording. Those scripts write page_text and never think about languages;
// this is what keeps them from having to.
func TestOneBlobTakesTheRecordingsLanguage(t *testing.T) {
	f := script.Fields{Language: "ru", PageText: "Лекция по Бхагавад-гите"}

	got := f.Words()
	if len(got) != 1 {
		t.Fatalf("got %d texts, want 1", len(got))
	}
	if got[0].Lang != "ru" || got[0].Text != "Лекция по Бхагавад-гите" {
		t.Errorf("got %+v", got[0])
	}
}

// A record with nothing to say has no texts, rather than one empty one. An
// empty row would be a transcript that exists and says nothing.
func TestNoProseIsNoTexts(t *testing.T) {
	for _, f := range []script.Fields{
		{Language: "en"},
		{Language: "en", PageText: "   \n  "},
	} {
		if got := f.Words(); len(got) != 0 {
			t.Errorf("Fields%+v gave %d texts, want none", f, len(got))
		}
	}
}

// Where a script does know about languages, what it says stands: page_text is
// the short form and must not be mixed in alongside.
func TestSeveralLanguagesStandAsGiven(t *testing.T) {
	f := script.Fields{
		Language: "en",
		PageText: "ignored",
		Texts: []script.Text{
			{Lang: "en", Text: "first"},
			{Lang: "ru", Text: "second"},
		},
	}

	got := f.Words()
	if len(got) != 2 {
		t.Fatalf("got %d texts, want 2", len(got))
	}
	if got[0].Lang != "en" || got[1].Lang != "ru" {
		t.Errorf("got %+v", got)
	}
	for _, w := range got {
		if w.Text == "ignored" {
			t.Error("page_text was folded in on top of an explicit list")
		}
	}
}

// The YouTube channel we have carries one machine track per video and nothing
// published, so a recording with subtitles in several languages cannot be shown
// from a real page. It is a shape the reader already produces, so it is covered
// here rather than claimed to work.
func TestYouTubeKeepsEveryPublishedLanguage(t *testing.T) {
	page, err := json.Marshal(map[string]any{
		"id":          "abc123",
		"title":       "Bhagavad Gita 2.13",
		"channel":     "Some Swami",
		"upload_date": "20260801",
		"duration":    3600,
		"language":    "en-US",
		"_captions": []map[string]string{
			{"lang": "en", "origin": "published", "json3": json3("in the beginning")},
			{"lang": "ru", "origin": "published", "json3": json3("в начале")},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	r, err := script.New()
	if err != nil {
		t.Fatal(err)
	}
	url := "https://www.youtube.com/watch?v=abc123"
	got, err := r.Run(context.Background(), "youtube",
		script.Page{URL: url, HTML: string(page)},
		[]script.Item{{URL: url}})
	if err != nil {
		t.Fatal(err)
	}

	f, ok := got[url]
	if !ok {
		t.Fatalf("no fields for %s; got %v", url, got)
	}
	texts := f.Words()
	if len(texts) != 2 {
		t.Fatalf("got %d texts, want both published languages: %+v", len(texts), texts)
	}
	if texts[0].Lang != "en" || texts[1].Lang != "ru" {
		t.Errorf("languages = %q, %q", texts[0].Lang, texts[1].Lang)
	}
	// The recording's own language is the first track's, which the reader
	// orders as published-then-original. It is never read off the words.
	if f.Language != "en" {
		t.Errorf("language = %q, want en", f.Language)
	}
}

// json3 is the caption shape YouTube serves, cut down to what the script reads.
func json3(words string) string {
	b, _ := json.Marshal(map[string]any{
		"events": []map[string]any{
			{"tStartMs": 0, "dDurationMs": 1000, "segs": []map[string]string{{"utf8": words}}},
		},
	})
	return string(b)
}

// A video page points nowhere, and saying so is not the same as saying nothing.
// Read as silence, the flattened JSON stands in — and one video's JSON names a
// thousand caption addresses under a path robots.txt forbids.
func TestNoLinksIsAnAnswer(t *testing.T) {
	r, err := script.New()
	if err != nil {
		t.Fatal(err)
	}
	video, err := json.Marshal(map[string]any{"id": "abc123", "title": "One talk"})
	if err != nil {
		t.Fatal(err)
	}

	got, err := r.Links(context.Background(), "youtube", script.Page{HTML: string(video)})
	if err != nil {
		t.Fatal(err)
	}
	if !got.Answered {
		t.Error("the script ran and returned a list; that is an answer")
	}
	if len(got.URLs) != 0 {
		t.Errorf("a video page points at %d addresses, want none", len(got.URLs))
	}
}

// A source with no script of its own has not answered, and what flattening
// found must stand.
func TestNoScriptIsSilence(t *testing.T) {
	r, err := script.New()
	if err != nil {
		t.Fatal(err)
	}
	got, err := r.Links(context.Background(), "nosuchsource", script.Page{})
	if err != nil {
		t.Fatal(err)
	}
	if got.Answered {
		t.Error("a source without a script must not look like one that answered")
	}
}
