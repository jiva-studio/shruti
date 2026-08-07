package script

import (
	"strings"

	"github.com/jiva-studio/shruti/discovery/internal/domain"

	htmltomarkdown "github.com/JohannesKaufmann/html-to-markdown/v2"
	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
)

// Markdown turns a piece of an archive's page into Markdown.
//
// This is the one thing a script is given from outside itself, and it is given
// because the alternative was worse. Reading markup with regular expressions
// works until it does not: a <div> nested inside the block being matched ends
// the match early, an attribute containing ">" ends a tag early, and an entity
// nobody thought of survives into the stored text. All three were happening.
//
// It stays a pure function of its input — no filesystem, no network, no clock —
// so the sandbox is what it was.
//
// Site knowledge does not move into Go. The script says which part of the page
// holds the prose and which parts of it are not prose; this only knows how to
// parse HTML and write Markdown.
type mdOptions struct {
	// Select is the element holding the text, as attribute=value ("itemprop=
	// transcript"), .class or #id. Empty converts the whole fragment.
	Select string `json:"select"`
	// Drop names elements to remove before converting, in the same notation.
	// Timings are the case this exists for: they are on the archive's clock and
	// do not line up with our own re-encode of the audio, so a citation cut
	// against them would be wrong in a way nobody could see.
	Drop []string `json:"drop"`
}

// Markdown is bound into every script's runtime as markdown(html, options).
func Markdown(fragment string, opts mdOptions) (string, error) {
	doc, err := html.Parse(strings.NewReader(fragment))
	if err != nil {
		return "", err
	}

	node := doc
	if opts.Select != "" {
		node = find(doc, parseSelector(opts.Select))
		if node == nil {
			return "", nil
		}
	}
	for _, sel := range opts.Drop {
		removeAll(node, parseSelector(sel))
	}
	unlinkAll(node)

	out, err := htmltomarkdown.ConvertNode(node)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// selector is the small part of CSS worth having here: an element by class, by
// id, or by any attribute. Anything more and this would be a CSS engine, which
// is not what a source script needs to say "the prose is in here".
type selector struct{ attr, value string }

func parseSelector(s string) selector {
	s = strings.TrimSpace(s)
	switch {
	case strings.HasPrefix(s, "."):
		return selector{attr: "class", value: s[1:]}
	case strings.HasPrefix(s, "#"):
		return selector{attr: "id", value: s[1:]}
	}
	if k, v, ok := strings.Cut(s, "="); ok {
		return selector{attr: strings.TrimSpace(k), value: strings.Trim(strings.TrimSpace(v), `"'`)}
	}
	return selector{}
}

func (sel selector) matches(n *html.Node) bool {
	if n.Type != html.ElementNode || sel.attr == "" {
		return false
	}
	for _, a := range n.Attr {
		if a.Key != sel.attr {
			continue
		}
		if a.Val == sel.value {
			return true
		}
		// class is a list, and "timing" must match class="timing playing".
		if sel.attr == "class" {
			for _, f := range strings.Fields(a.Val) {
				if f == sel.value {
					return true
				}
			}
		}
	}
	return false
}

func find(n *html.Node, sel selector) *html.Node {
	if sel.matches(n) {
		return n
	}
	for c := n.FirstChild; c != nil; c = c.NextSibling {
		if got := find(c, sel); got != nil {
			return got
		}
	}
	return nil
}

// unlinkAll keeps the words of every link and throws away its address.
//
// Measured on real transcripts, the addresses are of three kinds and not one of
// them earns its place. An archive's own tag pages and its transcribers'
// profiles — "/tags/273", "/users/75" — are numbers that mean nothing anywhere
// else. The one that leaves the site points at the verse under discussion on
// another library, which reads useful and is not: we already carry references
// as references, and a link is not one.
//
// The words stay, because they are in the sentence: "это уровень бхакти, когда
// мы связаны с Богом" is prose with a tag link sitting in the middle of it.
// What goes is what would be embedded at our expense and read by nobody.
func unlinkAll(root *html.Node) {
	var doomed []*html.Node
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			if c.Type == html.ElementNode && c.DataAtom == atom.A {
				doomed = append(doomed, c)
			}
			walk(c)
		}
	}
	walk(root)

	// Unwrapped rather than removed: the anchor goes, its words stay.
	for _, a := range doomed {
		for c := a.FirstChild; c != nil; {
			next := c.NextSibling
			a.RemoveChild(c)
			a.Parent.InsertBefore(c, a)
			c = next
		}
		a.Parent.RemoveChild(a)
	}
}

func removeAll(n *html.Node, sel selector) {
	var doomed []*html.Node
	var walk func(*html.Node)
	walk = func(x *html.Node) {
		for c := x.FirstChild; c != nil; c = c.NextSibling {
			if sel.matches(c) {
				doomed = append(doomed, c)
				continue
			}
			walk(c)
		}
	}
	walk(n)
	for _, d := range doomed {
		d.Parent.RemoveChild(d)
	}
}

// Language is what a page states it is written in — the lang attribute on
// <html>, which every archive here sets and none of them lies about. Nothing is
// inferred from the words: a page that states nothing yields nothing, because
// "not stated" and "English" are not the same answer.
func Language(fragment string) string {
	doc, err := html.Parse(strings.NewReader(fragment))
	if err != nil {
		return ""
	}
	var found string
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		if found != "" {
			return
		}
		if n.Type == html.ElementNode && n.DataAtom == atom.Html {
			for _, a := range n.Attr {
				if a.Key == "lang" && len(a.Val) >= 2 {
					found = strings.ToLower(a.Val[:2])
					return
				}
			}
		}
		for c := n.FirstChild; c != nil; c = c.NextSibling {
			walk(c)
		}
	}
	walk(doc)
	return found
}

// refsResult is what the refs() binding hands back: what the line cites, and
// the line with those citations replaced by the caller's marker.
type refsResult struct {
	Refs []domain.Ref `json:"refs"`
	Rest string       `json:"rest"`
}

// readRefs is the refs() binding. gap is what stands where a citation was; a
// script that only wants the references passes nothing and gets them removed.
func readRefs(text, gap string) refsResult {
	cites := domain.Cites(text)
	out := refsResult{Refs: make([]domain.Ref, 0, len(cites))}
	var rest strings.Builder
	last := 0
	for _, c := range cites {
		out.Refs = append(out.Refs, c.Ref)
		rest.WriteString(text[last:c.Start])
		rest.WriteString(gap)
		last = c.End
	}
	rest.WriteString(text[last:])
	out.Rest = rest.String()
	return out
}
