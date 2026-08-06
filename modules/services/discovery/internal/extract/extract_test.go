package extract_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/jiva-studio/lectorium/discovery/internal/domain"
	"github.com/jiva-studio/lectorium/discovery/internal/extract"
)

// fixtures are real pages, saved once, stripped to the markup the assertions
// walk. Every test here runs offline, with no keys, against these bytes.
//
// A saved page is somebody else's whole document — their markup, their prose,
// whatever their scripts carry. One is kept only where synthetic markup could
// not make the same point: a real listing proves that twenty-eight files each
// come away with their own row, which invented markup would only assume.
var fixtures = map[string]string{
	"bgclass_item.html": "https://bhagavadgitaclass.com/bhagavad-gita-chapter-02-text-13/",
	"idt_listing.html":  "http://audio.iskcondesiretree.com/05_-_ISKCON_Chowpatty/21_-_2025/11_-_November/",
}

func parseFixture(t *testing.T, name string) *domain.Extraction {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	out, err := extract.Parse(raw, "text/html", fixtures[name])
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func parse(t *testing.T, body, contentType, pageURL string) *domain.Extraction {
	t.Helper()
	out, err := extract.Parse([]byte(body), contentType, pageURL)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

// A file listing must yield one record per file, each carrying the row it sits
// in rather than its neighbours'.
func TestFileListing(t *testing.T) {
	out := parseFixture(t, "idt_listing.html")

	if len(out.Items) != 28 {
		t.Fatalf("items = %d, want 28", len(out.Items))
	}
	for _, it := range out.Items {
		if it.Filename == "" || len(it.PathSegments) != 3 {
			t.Errorf("%s: filename=%q segments=%v", it.MediaURL, it.Filename, it.PathSegments)
		}
		// The row a file sits in reads as its filename does, with the
		// underscores spelled out.
		spoken := strings.ReplaceAll(strings.TrimSuffix(it.Filename, ".mp3"), "_", " ")
		if !strings.Contains(it.ContextText, spoken[:40]) {
			t.Errorf("%s: context does not carry its own row\n  ctx=%.200q", it.Filename, it.ContextText)
		}
		if len(it.ContextText) > 2000 {
			t.Errorf("%s: context of %d bytes swallowed the page", it.Filename, len(it.ContextText))
		}
	}
}

// A page carrying one recording is entirely about it, so the whole page travels
// with it and the text is marked as the recording's own.
func TestSingleRecordingTakesWholePage(t *testing.T) {
	out := parse(t, `<html><head><title>A talk</title></head><body>
		<h1>A talk</h1><p>Given in Vrindavan, 1972.</p>
		<a href="/media/talk.mp3">download</a>
		<p>On the nature of the soul.</p></body></html>`,
		"text/html", "https://example.org/talks/1")

	if len(out.Items) != 1 {
		t.Fatalf("items = %d, want 1", len(out.Items))
	}
	it := out.Items[0]
	if it.TextRole != domain.TextCanonical {
		t.Errorf("text role = %q, want canonical", it.TextRole)
	}
	if !strings.Contains(it.ContextText, "nature of the soul") ||
		!strings.Contains(it.ContextText, "Vrindavan") {
		t.Errorf("context missed text on the other side of the link: %q", it.ContextText)
	}
	if it.MediaURL != "https://example.org/media/talk.mp3" {
		t.Errorf("media url = %q", it.MediaURL)
	}
}

// Text shared by several recordings on one page is searchable but is not any
// one recording's own words.
func TestSharedTextRole(t *testing.T) {
	out := parseFixture(t, "bgclass_item.html")
	if len(out.Items) < 2 {
		t.Fatalf("items = %d, want several", len(out.Items))
	}
	for _, it := range out.Items {
		if it.TextRole != domain.TextShared {
			t.Fatalf("%s: text role = %q, want shared", it.Filename, it.TextRole)
		}
	}
}

// The same content in three unrelated markups must come out the same. This is
// the property that makes the engine general: it reads text and addresses, not
// layout.
func TestMarkupIndependence(t *testing.T) {
	markups := map[string]string{
		"table": `<table><tr><td>First talk</td><td><a href="/a.mp3">get</a></td></tr>
			<tr><td>Second talk</td><td><a href="/b.mp3">get</a></td></tr></table>`,
		"list": `<ul><li>First talk <a href="/a.mp3">get</a></li>
			<li>Second talk <a href="/b.mp3">get</a></li></ul>`,
		"divs": `<div class="x9f"><div>First talk</div><div><a href="/a.mp3">get</a></div></div>
			<div class="x9f"><div>Second talk</div><div><a href="/b.mp3">get</a></div></div>`,
	}

	for name, body := range markups {
		out := parse(t, "<html><body>"+body+"</body></html>", "text/html", "https://example.org/list")
		if len(out.Items) != 2 {
			t.Fatalf("%s: items = %d, want 2", name, len(out.Items))
		}
		if out.Items[0].MediaURL != "https://example.org/a.mp3" ||
			out.Items[1].MediaURL != "https://example.org/b.mp3" {
			t.Fatalf("%s: urls = %q, %q", name, out.Items[0].MediaURL, out.Items[1].MediaURL)
		}
		if !strings.Contains(out.Items[0].ContextText, "First talk") {
			t.Errorf("%s: item 0 context = %q", name, out.Items[0].ContextText)
		}
		if !strings.Contains(out.Items[1].ContextText, "Second talk") ||
			strings.Contains(out.Items[1].ContextText, "First talk") {
			t.Errorf("%s: item 1 context = %q", name, out.Items[1].ContextText)
		}
	}
}

// A JSON API is read the same way a page is: values become text, addresses
// become items. No knowledge of which key a source calls its title.
func TestJSONResponse(t *testing.T) {
	body := `[{"title":{"rendered":"Chapter 2 <em>Text</em> 13"},
		"date":"2019-04-02T10:00:00","link":"https://example.org/post/1",
		"audio":"https://example.org/wp-content/audio/BG_02_13.mp3"}]`

	out := parse(t, body, "application/json", "https://example.org/wp-json/wp/v2/posts")

	if len(out.Items) != 1 {
		t.Fatalf("items = %d, want 1", len(out.Items))
	}
	if out.Items[0].Filename != "BG_02_13.mp3" {
		t.Errorf("filename = %q", out.Items[0].Filename)
	}
	if !strings.Contains(out.PageText, "Chapter 2 Text 13") {
		t.Errorf("markup inside a JSON value survived: %q", out.PageText)
	}
	if !strings.Contains(out.PageText, "2019-04-02") {
		t.Errorf("text lost the source's own fields: %q", out.PageText)
	}
	if len(out.Links) != 1 || out.Links[0] != "https://example.org/post/1" {
		t.Errorf("links = %v", out.Links)
	}
}

// Sniffing covers sources that serve JSON without saying so.
func TestJSONWithoutContentType(t *testing.T) {
	out := parse(t, `{"file":"https://example.org/a.mp3"}`, "", "https://example.org/api")
	if len(out.Items) != 1 {
		t.Fatalf("items = %d, want 1", len(out.Items))
	}
}

// Only same-host pages are queued; media is an item wherever it lives.
func TestLinksAndMedia(t *testing.T) {
	out := parse(t, `<html><body>
		<a href="/next">next page</a>
		<a href="https://elsewhere.example/other">offsite</a>
		<a href="https://cdn.example/x.mp3">audio elsewhere</a>
		<a href="#top">anchor</a></body></html>`,
		"text/html", "https://example.org/index")

	if len(out.Links) != 1 || out.Links[0] != "https://example.org/next" {
		t.Errorf("links = %v", out.Links)
	}
	if len(out.Items) != 1 || out.Items[0].MediaURL != "https://cdn.example/x.mp3" {
		t.Errorf("items = %+v", out.Items)
	}
}

func TestIsMediaURL(t *testing.T) {
	yes := []string{"http://a/b.mp3", "http://a/b.MP3", "http://a/b.m4a?x=1", "http://a/b.opus#f"}
	no := []string{"http://a/b.html", "http://a/mp3", "http://a/b.mp3.html", "http://a/"}
	for _, u := range yes {
		if !extract.IsMediaURL(u) {
			t.Errorf("%s: want media", u)
		}
	}
	for _, u := range no {
		if extract.IsMediaURL(u) {
			t.Errorf("%s: want not media", u)
		}
	}
}

// Archives are old. A page that says it is windows-1251 must not come back as
// mojibake — the title is the strongest signal we have for a recording.
func TestLegacyEncoding(t *testing.T) {
	body := []byte("<html><head><title>\xcb\xe5\xea\xf6\xe8\xff</title></head><body>" +
		"<p>\xc2\xe0\xf1\xe8\xeb\xe8\xe9 \xd2\xf3\xf8\xea\xe8\xed</p>" +
		"<a href=\"/a.mp3\">\xf1\xea\xe0\xf7\xe0\xf2\xfc</a></body></html>")

	out, err := extract.Parse(body, "text/html; charset=windows-1251", "https://example.ru/x")
	if err != nil {
		t.Fatal(err)
	}
	if out.PageTitle != "Лекция" {
		t.Errorf("title = %q, want %q", out.PageTitle, "Лекция")
	}
	if !strings.Contains(out.PageText, "Василий Тушкин") {
		t.Errorf("text = %q", out.PageText)
	}
}

// Byte limits must not cut a character in half. A Cyrillic letter is two
// bytes, and half of one is not text — Postgres refuses to store it, so a long
// Russian transcript would fail depending on where the limit happened to land.
func TestLimitsRespectCharacterBoundaries(t *testing.T) {
	// Two-byte letters with a one-byte marker, so every possible cut offset
	// lands mid-character for some prefix length.
	body := "<html><body><p>x" + strings.Repeat("я", 60000) + "</p>" +
		`<a href="/a.mp3">качать</a></body></html>`

	out := parse(t, body, "text/html", "https://example.ru/x")
	if len(out.Items) != 1 {
		t.Fatalf("items = %d", len(out.Items))
	}
	for _, s := range []string{out.PageText, out.Items[0].ContextText} {
		if !utf8.ValidString(s) {
			t.Errorf("cut produced invalid UTF-8 at byte %d of %d", firstBadByte(s), len(s))
		}
	}
}

func firstBadByte(s string) int {
	for i, r := range s {
		if r == utf8.RuneError {
			return i
		}
	}
	return -1
}

// A link to something that is not a page is not a page to visit. Fetching one
// to find out costs its whole size, and archives carry presentations and zips
// alongside the recordings.
func TestLinksSkipNonPages(t *testing.T) {
	html := `<html><body>
		<a href="/lectures/">Lectures</a>
		<a href="/slides/Chapter_09.ppt">Slides</a>
		<a href="/slides/Chapter_09.pptx">Slides</a>
		<a href="/kirtan/Festival-2014.rar">Festival</a>
		<a href="/handout.pdf">Handout</a>
		<a href="/logo.png">Logo</a>
		<a href="/page.html">Page</a>
	</body></html>`

	out, err := extract.Parse([]byte(html), "text/html", "https://example.org/a")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"https://example.org/lectures/", "https://example.org/page.html"}
	if len(out.Links) != len(want) {
		t.Fatalf("links = %v, want %v", out.Links, want)
	}
	for i, w := range want {
		if out.Links[i] != w {
			t.Errorf("links[%d] = %q, want %q", i, out.Links[i], w)
		}
	}
}
