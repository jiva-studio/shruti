package script_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/jiva-studio/shruti/discovery/internal/application/script"
)

// Every archive reads its citations the same way, out of one canon. These are
// the three that had none: youtube.js and audioveda.js answer completely, so
// nothing they miss ever reaches a model, and idt.js had its own private list
// of books which knew six of the seventeen.

func recordings(t *testing.T, scriptID string, page script.Page) script.Fields {
	t.Helper()
	r, err := script.New()
	if err != nil {
		t.Fatal(err)
	}
	got, err := r.Run(context.Background(), scriptID, page, []script.Item{{URL: page.URL}})
	if err != nil {
		t.Fatal(err)
	}
	f, ok := got[page.URL]
	if !ok {
		t.Fatalf("the script said nothing about %s (answered about %d files)", page.URL, len(got))
	}
	return f
}

func labels(f script.Fields) []string {
	out := []string{}
	for _, r := range f.References {
		out = append(out, r.Label())
	}
	return out
}

func TestYouTubeReadsTheCitationInItsTitle(t *testing.T) {
	doc, err := json.Marshal(map[string]any{
		"_type":       "video",
		"id":          "abc",
		"title":       "Парататтва дас - Шримад Бхагаватам 4.12.35. - 18.06.2024.",
		"channel":     "Гаура СПб",
		"upload_date": "20240618",
	})
	if err != nil {
		t.Fatal(err)
	}
	got := recordings(t, "youtube", script.Page{
		URL: "https://www.youtube.com/watch?v=abc", HTML: string(doc), Text: string(doc)})
	if refs := labels(got); len(refs) != 1 || refs[0] != "SB 4.12.35" {
		t.Errorf("references = %v, want [SB 4.12.35]", refs)
	}
}

func TestAudiovedaReadsTheCitationInItsTitle(t *testing.T) {
	const page = `<html><head><script type="application/ld+json">
	{"@type":"AudioObject","name":"ШБ 6.12.2-7 - Славная смерть Вритрасуры",
	 "author":{"name":"Бхакти Вигьяна Госвами"},"datePublished":"2019-03-04"}
	</script></head><body></body></html>`
	got := recordings(t, "audioveda", script.Page{
		URL: "https://audioveda.ru/audio/1", HTML: page, Text: page})
	want := []string{"SB 6.12.2", "SB 6.12.3", "SB 6.12.4", "SB 6.12.5", "SB 6.12.6", "SB 6.12.7"}
	if refs := labels(got); len(refs) != 1 || refs[0] != "SB 6.12.2-7" {
		t.Errorf("references = %v, want [SB 6.12.2-7] (which expands to %v later)", refs, want)
	}
}
