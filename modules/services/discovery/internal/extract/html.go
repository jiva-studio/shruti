package extract

import (
	"bytes"
	"net/url"
	"strings"

	"github.com/jiva-studio/lectorium/discovery/internal/domain"
	"golang.org/x/net/html"
	"golang.org/x/net/html/charset"
)

// nonText are elements whose contents are code or markup, never prose.
var nonText = map[string]bool{
	"script": true, "style": true, "noscript": true, "template": true,
	"svg": true, "head": true,
}

// blockTags end a line when flattening, so the text reads the way the page
// reads instead of running together.
var blockTags = map[string]bool{
	"p": true, "div": true, "section": true, "article": true, "li": true,
	"tr": true, "td": true, "th": true, "br": true, "h1": true, "h2": true,
	"h3": true, "h4": true, "h5": true, "h6": true, "blockquote": true,
	"pre": true, "dt": true, "dd": true, "figcaption": true, "option": true,
}

// mediaAttrs are the attributes a media file's address can sit in.
var mediaAttrs = []string{"href", "src", "data-src", "content"}

func parseHTML(raw []byte, contentType, pageURL string) (*domain.Extraction, error) {
	base, err := url.Parse(pageURL)
	if err != nil {
		return nil, err
	}
	// Archives are old and plenty of them still serve windows-1251 or
	// ISO-8859-1. Reading those bytes as UTF-8 turns every Cyrillic title into
	// noise, so the declared or sniffed encoding decides.
	reader, err := charset.NewReader(bytes.NewReader(raw), contentType)
	if err != nil {
		reader = bytes.NewReader(raw)
	}
	doc, err := html.Parse(reader)
	if err != nil {
		return nil, err
	}

	f := &flattener{base: base}
	f.walk(doc)

	out := &domain.Extraction{
		PageTitle: f.title,
		PageText:  f.text(),
		Links:     f.links,
	}
	out.Items = itemsFromMarks(f.marks, out.PageText, pageURL)
	return out, nil
}

// flattener turns a document into one text stream, remembering where in that
// stream each media URL appeared.
type flattener struct {
	base  *url.URL
	sb    strings.Builder
	title string
	marks []mark
	links []string
	seen  map[string]bool
}

// mark is a media URL and the offset in the flattened text where it was found.
type mark struct {
	url    string
	offset int
}

func (f *flattener) walk(n *html.Node) {
	switch n.Type {
	case html.TextNode:
		f.write(n.Data)
		return
	case html.ElementNode:
		if nonText[n.Data] {
			if n.Data == "head" {
				f.readTitle(n)
			}
			return
		}
		f.readNode(n)
		if blockTags[n.Data] {
			f.newline()
		}
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		f.walk(c)
	}
	if n.Type == html.ElementNode && blockTags[n.Data] {
		f.newline()
	}
}

func (f *flattener) readTitle(head *html.Node) {
	for c := head.FirstChild; c != nil; c = c.NextSibling {
		if c.Type == html.ElementNode && c.Data == "title" && c.FirstChild != nil {
			f.title = clean(c.FirstChild.Data)
			return
		}
	}
}

// readNode records every address this element carries: media files as marks,
// same-host pages as links to visit next.
func (f *flattener) readNode(n *html.Node) {
	for _, key := range mediaAttrs {
		raw := attr(n, key)
		if raw == "" {
			continue
		}
		abs := absolute(f.base, raw)
		if abs == "" {
			continue
		}
		if IsMediaURL(abs) {
			f.addMark(abs)
			continue
		}
		if key == "href" && n.Data == "a" {
			f.addLink(abs)
		}
	}
}

func (f *flattener) addMark(u string) {
	if f.seen == nil {
		f.seen = map[string]bool{}
	}
	if f.seen[u] {
		return
	}
	f.seen[u] = true
	f.marks = append(f.marks, mark{url: u, offset: f.sb.Len()})
}

func (f *flattener) addLink(raw string) {
	u, err := url.Parse(raw)
	if err != nil || u.Host != f.base.Host {
		return
	}
	u.Fragment = ""
	s := u.String()
	if f.seen == nil {
		f.seen = map[string]bool{}
	}
	if f.seen[s] {
		return
	}
	f.seen[s] = true
	f.links = append(f.links, s)
}

func (f *flattener) write(s string) {
	s = strings.Join(strings.Fields(s), " ")
	if s == "" {
		return
	}
	if cur := f.sb.String(); cur != "" && !strings.HasSuffix(cur, "\n") && !strings.HasSuffix(cur, " ") {
		f.sb.WriteByte(' ')
	}
	f.sb.WriteString(s)
}

func (f *flattener) newline() {
	if cur := f.sb.String(); cur == "" || strings.HasSuffix(cur, "\n") {
		return
	}
	f.sb.WriteByte('\n')
}

func (f *flattener) text() string {
	return strings.TrimSpace(f.sb.String())
}

func attr(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if a.Key == key {
			return a.Val
		}
	}
	return ""
}

func absolute(base *url.URL, href string) string {
	href = strings.TrimSpace(href)
	if href == "" || strings.HasPrefix(href, "#") ||
		strings.HasPrefix(href, "javascript:") || strings.HasPrefix(href, "mailto:") {
		return ""
	}
	u, err := url.Parse(href)
	if err != nil {
		return ""
	}
	return base.ResolveReference(u).String()
}

func clean(s string) string {
	return strings.Join(strings.Fields(s), " ")
}
