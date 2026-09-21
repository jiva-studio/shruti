package script_test

import (
	"os"
	"strings"
	"testing"

	"github.com/jiva-studio/lectorium/discovery/internal/application/script"
)

// The archive publishes schema.org, so nothing here is inferred. What this
// guards is that we read what it says rather than something near it.
func TestAudiovedaReadsWhatTheSiteStates(t *testing.T) {
	for _, c := range []struct {
		file, title, author, date, series string
		minText                           int
	}{
		{"av_auth.html", "Лекция для брахмачари", "Леонид Тугутов", "2023-01-23", "Брахмачари ашрам", 4000},
		{"av844.html", "ШБ 7.15.38-39 - Наставления для цивилизованных людей", "Леонид Тугутов", "2010-03-03", "Лекции по Шримад Бхагаватам", 80000},
	} {
		html, err := os.ReadFile(os.Getenv("AV_DIR") + "/" + c.file)
		if err != nil {
			t.Skip(err)
		}
		r, err := script.New()
		if err != nil {
			t.Fatal(err)
		}
		got, err := r.Run(t.Context(), "audioveda",
			script.Page{HTML: string(html)},
			[]script.Item{{URL: "u", Filename: "x.mp3"}})
		if err != nil {
			t.Fatal(err)
		}
		f := got["u"]
		if f.Title != c.title {
			t.Errorf("%s title = %q, want %q", c.file, f.Title, c.title)
		}
		if f.Author != c.author {
			t.Errorf("%s author = %q, want %q", c.file, f.Author, c.author)
		}
		if f.Date != c.date {
			t.Errorf("%s date = %q, want %q", c.file, f.Date, c.date)
		}
		if f.CollectionTitle != c.series {
			t.Errorf("%s series = %q, want %q", c.file, f.CollectionTitle, c.series)
		}
		if len(f.PageText) < c.minText {
			t.Errorf("%s transcript = %d chars, want at least %d", c.file, len(f.PageText), c.minText)
		}
		if strings.Contains(f.PageText, "<") || strings.Contains(f.PageText, "&nbsp") {
			t.Errorf("%s transcript still carries markup", c.file)
		}
		// The timings are the one thing deliberately dropped.
		if strings.Contains(f.PageText, "00:00:") {
			t.Errorf("%s transcript kept a timing", c.file)
		}
	}
}
