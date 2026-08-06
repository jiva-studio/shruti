package ytdlp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The rule these guard is a correctness rule and not a preference: YouTube
// offers the machine transcript auto-translated into a hundred and fifty-odd
// languages, and only one of them is what was said. Taking the wrong one stores
// a translation as the transcript, which reads as evidence and is not.

func dump(t *testing.T, doc map[string]any) []byte {
	t.Helper()
	b, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func tracksAt(server, lang string) []map[string]string {
	return []map[string]string{
		{"ext": "json3", "url": server + "/cap?lang=" + lang},
		{"ext": "vtt", "url": server + "/cap.vtt?lang=" + lang},
	}
}

// captionServer answers any caption request with text naming what was asked for,
// so a test can tell which track was actually taken.
func captionServer(t *testing.T) (*httptest.Server, *int) {
	t.Helper()
	var hits int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		_, _ = w.Write([]byte(`{"events":[{"segs":[{"utf8":"` + r.URL.Query().Get("lang") + `"}]}]}`))
	}))
	t.Cleanup(srv.Close)
	return srv, &hits
}

func newTestClient() *Client { return New(Options{UserAgent: "test/1"}) }

// spoke reads back which track the server was asked for. Matching on a raw
// substring does not work — "events" contains "en".
func spoke(t *testing.T, json3 string) string {
	t.Helper()
	var doc struct {
		Events []struct {
			Segs []struct {
				UTF8 string `json:"utf8"`
			} `json:"segs"`
		} `json:"events"`
	}
	if err := json.Unmarshal([]byte(json3), &doc); err != nil {
		t.Fatalf("caption text %q: %v", json3, err)
	}
	if len(doc.Events) == 0 || len(doc.Events[0].Segs) == 0 {
		t.Fatalf("caption text has no words: %q", json3)
	}
	return doc.Events[0].Segs[0].UTF8
}

// A talk given in English: "en" is one of the translation targets and "en-orig"
// is what was heard.
func TestTheOriginalIsTakenNotATranslation(t *testing.T) {
	srv, hits := captionServer(t)
	c := newTestClient()

	body := dump(t, map[string]any{
		"language": "en-US",
		"automatic_captions": map[string]any{
			"en":      tracksAt(srv.URL, "en"),
			"en-orig": tracksAt(srv.URL, "en-orig"),
			"ru":      tracksAt(srv.URL, "ru"),
			"hi":      tracksAt(srv.URL, "hi"),
		},
	})

	got := c.captions(context.Background(), body)
	if len(got) != 1 {
		t.Fatalf("took %d tracks, want exactly the original", len(got))
	}
	if got[0].Lang != "en" || got[0].Origin != "auto" {
		t.Errorf("took %+v", got[0])
	}
	if spoke(t, got[0].JSON3) != "en-orig" {
		t.Errorf("took the %s track rather than the original", spoke(t, got[0].JSON3))
	}
	if *hits != 1 {
		t.Errorf("fetched %d tracks; a hundred and fifty translations are not worth one request each", *hits)
	}
}

// A Russian lecture. A fixed preference for English would take the machine's
// English translation of it and call that the transcript.
func TestARussianTalkIsNotStoredInEnglish(t *testing.T) {
	srv, _ := captionServer(t)
	c := newTestClient()

	body := dump(t, map[string]any{
		"language": "ru",
		"automatic_captions": map[string]any{
			"en": tracksAt(srv.URL, "en"),
			"ru": tracksAt(srv.URL, "ru"),
			"es": tracksAt(srv.URL, "es"),
		},
	})

	got := c.captions(context.Background(), body)
	if len(got) != 1 || got[0].Lang != "ru" {
		t.Fatalf("took %+v, want the Russian original", got)
	}
	if spoke(t, got[0].JSON3) != "ru" {
		t.Errorf("took the %s track for a Russian talk", spoke(t, got[0].JSON3))
	}
}

// What the uploader published is separate human work in each language, and all
// of it is kept — and it beats what the machine heard.
func TestEveryPublishedLanguageIsKept(t *testing.T) {
	srv, _ := captionServer(t)
	c := newTestClient()

	body := dump(t, map[string]any{
		"language": "en-US",
		"subtitles": map[string]any{
			"en": tracksAt(srv.URL, "en"),
			"ru": tracksAt(srv.URL, "ru"),
		},
		"automatic_captions": map[string]any{"en-orig": tracksAt(srv.URL, "auto")},
	})

	got := c.captions(context.Background(), body)
	if len(got) != 2 {
		t.Fatalf("kept %d published tracks, want both", len(got))
	}
	for _, cap := range got {
		if cap.Origin != "published" {
			t.Errorf("%s came back as %q; the machine's version was preferred over the author's", cap.Lang, cap.Origin)
		}
	}
}

// Where nothing says which language was spoken, nothing can be called the
// original — and a translation stored as the transcript is worse than no
// transcript at all.
func TestNoOriginalMeansNoTranscript(t *testing.T) {
	srv, hits := captionServer(t)
	c := newTestClient()

	body := dump(t, map[string]any{
		"automatic_captions": map[string]any{
			"en": tracksAt(srv.URL, "en"),
			"ru": tracksAt(srv.URL, "ru"),
		},
	})

	if got := c.captions(context.Background(), body); len(got) != 0 {
		t.Errorf("took %+v with nothing to say which was spoken", got)
	}
	if *hits != 0 {
		t.Errorf("fetched %d tracks it had no reason to trust", *hits)
	}
}

func TestBaseLang(t *testing.T) {
	for in, want := range map[string]string{
		"en-US": "en", "ru": "ru", "pt_BR": "pt", "EN": "en", "": "",
	} {
		if got := baseLang(in); got != want {
			t.Errorf("baseLang(%q) = %q, want %q", in, got, want)
		}
	}
}

// The catalogue must go, and this is why: its addresses are signed per request,
// so keeping them makes the body different on every reading of a video that has
// not changed — and the body is what the crawl compares to stop early.
func TestTheSameVideoReadTwiceIsTheSameBytes(t *testing.T) {
	srv, _ := captionServer(t)
	c := newTestClient()

	reading := func(signature string) []byte {
		return dump(t, map[string]any{
			"id":       "abc",
			"title":    "One talk",
			"language": "en-US",
			"epoch":    signature,
			"formats":  []map[string]string{{"url": "https://v.example/stream?sig=" + signature}},
			"thumbnails": []map[string]string{
				{"url": "https://i.example/thumb?sig=" + signature},
			},
			"automatic_captions": map[string]any{"en-orig": tracksAt(srv.URL, "en-orig")},
		})
	}

	first := c.indexable(context.Background(), reading("one"))
	second := c.indexable(context.Background(), reading("two"))
	if string(first) != string(second) {
		t.Errorf("two readings of one unchanged video differ:\n %s\n %s", first, second)
	}

	var doc map[string]any
	if err := json.Unmarshal(first, &doc); err != nil {
		t.Fatal(err)
	}
	for _, gone := range catalogue {
		if _, ok := doc[gone]; ok {
			t.Errorf("%q survived the strip", gone)
		}
	}
	if doc["title"] != "One talk" {
		t.Errorf("the strip took what it was meant to keep: %v", doc)
	}
	if _, ok := doc["_captions"]; !ok {
		t.Error("the words we went and fetched are not in what was handed over")
	}
}

// A video with no captions at all is still a recording worth indexing.
func TestNoCaptionsIsNotAFailure(t *testing.T) {
	c := newTestClient()
	body := dump(t, map[string]any{"id": "abc", "title": "Silent", "language": "en"})

	out := c.indexable(context.Background(), body)
	var doc map[string]any
	if err := json.Unmarshal(out, &doc); err != nil {
		t.Fatal(err)
	}
	if doc["title"] != "Silent" {
		t.Errorf("lost the recording along with its missing captions: %v", doc)
	}
	if _, ok := doc["_captions"]; ok {
		t.Error("invented captions for a video that has none")
	}
}

// Anything that is not the reader's JSON is handed on untouched rather than
// turned into an empty object.
func TestUnreadableOutputIsPassedThrough(t *testing.T) {
	c := newTestClient()
	raw := []byte("not json at all")
	if got := c.indexable(context.Background(), raw); string(got) != string(raw) {
		t.Errorf("= %q, want it passed through", got)
	}
}
