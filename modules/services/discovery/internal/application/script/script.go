// Package script runs a source's own extraction script over a page.
//
// Archives put the same facts in different places: one keeps the speaker in
// the directory path, another in a heading, a third only in the filename. No
// general rule finds all three, and guessing at markup is what a general
// engine must not do. A script per source says where its facts are, and the
// engine stays ignorant of every site.
//
// What a script fills is taken as given. What it leaves empty falls through to
// the model, so a half-written script is still worth having, and a complete one
// removes the model call entirely.
package script

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"io/fs"
	"strings"
	"time"

	"github.com/dop251/goja"

	"github.com/jiva-studio/lectorium/discovery/internal/domain"
)

//go:embed scripts/*.js
var scriptsFS embed.FS

// budget bounds one script's run. A script is somebody's code running on every
// page of a crawl; without a ceiling one bad loop stops the crawl for ever.
const budget = 2 * time.Second

// Page is what a script is given about the page itself.
type Page struct {
	URL   string   `json:"url"`
	Title string   `json:"title"`
	Text  string   `json:"text"`
	HTML  string   `json:"html"`
	Path  []string `json:"path"`
}

// Item is one media file, as found.
type Item struct {
	URL      string   `json:"url"`
	Filename string   `json:"filename"`
	Path     []string `json:"path"`
	Context  string   `json:"context"`
}

// Fields is what a script says about one file. Every field is optional; an
// empty one means the script had nothing to say, not that the answer is empty.
type Fields struct {
	URL    string `json:"url"`
	Title  string `json:"title"`
	Author string `json:"author"`
	// Authors is who spoke, when more than one did: a conversation, a joint
	// kirtan, a class given in turns.
	Authors         []string `json:"authors"`
	Location        string   `json:"location"`
	Date            string   `json:"date"`
	Language        string   `json:"language"`
	CollectionTitle string   `json:"collection_title"`
	// DurationS is how long the recording runs, where the archive says so.
	DurationS int `json:"duration_s"`
	// References are the scripture passages the line cites, already folded to
	// the canon. Objects rather than "BG 2.13" strings: a code with a space in
	// it cannot survive being cut back apart on the first one.
	References []domain.Ref `json:"references"`
	// CoverURL is the picture the archive publishes for this recording. The
	// script says it because the script is what knows: it holds the video's own
	// id, where a reader downstream would be matching the shape of an address
	// and guessing.
	CoverURL string `json:"cover_url"`

	// Complete is the script asserting it accounted for the whole of what the
	// page said about this file — that the fields left empty are empty because
	// the archive did not state them, not because nobody looked. Only then can
	// the model be skipped: an empty title otherwise means "unknown", and
	// unknown is exactly what a model is for.
	Complete bool `json:"complete"`

	// PageText is prose the archive published about this recording, in Markdown.
	// A search key, never a transcript of ours.
	//
	// It is the short form of Texts, for the many sources that publish words in
	// one language: whatever is here is folded into Texts under Language.
	PageText string `json:"page_text"`

	// Texts is the same thing when a source publishes in more than one language.
	// A site that writes its own subtitles writes them in every language it has
	// a translator for, and each is separate work rather than a copy.
	//
	// A script fills one of these or the other, never both.
	Texts []Text `json:"texts"`

	// Reasons is everything that stopped the script, when it stopped. A set,
	// not a choice: a line can lack a speaker and carry an unreadable date and
	// leave words unaccounted for at once, and a fix for one will not move it.
	//
	// Without this, "the model was called 142 times" cannot be turned into
	// "and here is what for", nor into a list of what to fix next.
	Reasons []string `json:"reasons"`
}

// Text is words the archive published, and the language it published them in.
// An empty Lang means the archive did not say; it does not mean English, and
// nothing here reads the words to guess.
type Text struct {
	Lang string `json:"lang"`
	Text string `json:"text"`
}

// Words returns everything this record has to say in prose, however the script
// chose to say it. Folding PageText in here rather than at each use is what
// keeps the single-language scripts — idt, audioveda — from having to know that
// several languages are possible.
func (f Fields) Words() []Text {
	if len(f.Texts) > 0 {
		return f.Texts
	}
	if strings.TrimSpace(f.PageText) == "" {
		return nil
	}
	return []Text{{Lang: f.Language, Text: f.PageText}}
}

// Answer is a script's reply about a page's addresses, and whether it made one.
//
// The two are separate because an empty list is an answer. "This page points
// nowhere" and "nobody looked" lead to opposite decisions: the first says use
// nothing, the second says fall back to what flattening found. Returning only a
// slice loses that, and the caller ends up guessing from its length — which is
// how a video page's honest "no links here" was read as silence, and a thousand
// caption addresses were followed instead.
type Answer struct {
	Answered bool
	URLs     []string
}

// Runner holds the scripts, compiled once.
type Runner struct {
	programs map[string]*goja.Program
	// versions is what each script hashes to. A page stores the version it was
	// read with, so correcting a script re-reads that source's pages instead of
	// leaving them as the old one left them.
	versions map[string]string
}

// New compiles every embedded script. A script that will not compile is an
// error now rather than a surprise on the first page of a crawl.
func New() (*Runner, error) {
	entries, err := fs.ReadDir(scriptsFS, "scripts")
	if err != nil {
		return nil, err
	}
	r := &Runner{programs: map[string]*goja.Program{}, versions: map[string]string{}}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".js") {
			continue
		}
		src, err := scriptsFS.ReadFile("scripts/" + e.Name())
		if err != nil {
			return nil, err
		}
		p, err := goja.Compile(e.Name(), string(src), true)
		if err != nil {
			return nil, fmt.Errorf("compile %s: %w", e.Name(), err)
		}
		id := strings.TrimSuffix(e.Name(), ".js")
		r.programs[id] = p
		sum := sha256.Sum256(src)
		r.versions[id] = hex.EncodeToString(sum[:])[:12]
	}
	return r, nil
}

// Version identifies the script a source is read with, so a page read by an
// older one is not mistaken for a page that is up to date. Empty for a source
// that has no script, which is most of them.
func (r *Runner) Version(sourceID string) string {
	if r == nil {
		return ""
	}
	return r.versions[sourceID]
}

// Has reports whether a source has a script at all.
func (r *Runner) Has(sourceID string) bool {
	if r == nil {
		return false
	}
	_, ok := r.programs[sourceID]
	return ok
}

// start compiles a runtime for one call and arms its budget.
//
// No filesystem, no network, no clock, no randomness. A goja runtime begins
// with none of them, and this is where they would have to be added on purpose.
//
// Two pure functions are added, and only because the alternative is worse:
// reading somebody's markup with regular expressions works until a nested
// element ends the match early or an entity nobody listed survives into the
// stored text, and both were happening. They take a string and return a string,
// they touch nothing, and they hold no knowledge of any site — the script still
// says which part of the page it means.
func (r *Runner) start(ctx context.Context, sourceID string) (*goja.Runtime, chan struct{}, error) {
	vm := goja.New()
	// Fields reach the script under their JSON names, so a script reads
	// page.url rather than page.URL.
	vm.SetFieldNameMapper(goja.TagFieldNameMapper("json", true))

	if err := vm.Set("markdown", func(fragment string, opts mdOptions) string {
		out, err := Markdown(fragment, opts)
		if err != nil {
			// A page this cannot be read out of is a page with no text, which
			// is an ordinary answer here. Failing the whole visit over it would
			// lose the recording as well as its prose.
			return ""
		}
		return out
	}); err != nil {
		return nil, nil, err
	}
	if err := vm.Set("pageLanguage", Language); err != nil {
		return nil, nil, err
	}
	// Who is speaking, out of a line the archive wrote. What a Vaishnava name
	// looks like is knowledge about this corpus and not about any site, so it
	// lives in domain; the script only says which line to look at.
	if err := vm.Set("speaker", domain.Speaker); err != nil {
		return nil, nil, err
	}
	// Which scripture a line cites, and the line with the citation taken out.
	// Both halves are needed by one script and one half by the others, so the
	// binding always returns both and a caller ignores what it does not want.
	//
	// The canon of scripture names lives in domain for the same reason a
	// Vaishnava name does: it is knowledge about this corpus, not about a site.
	// Handing the table to the script instead would move that judgement into
	// JavaScript once per script, where \b has the same defect it has in Go.
	if err := vm.Set("refs", readRefs); err != nil {
		return nil, nil, err
	}

	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			vm.Interrupt("cancelled")
		case <-time.After(budget):
			vm.Interrupt("script budget exceeded")
		case <-done:
		}
	}()

	if _, err := vm.RunProgram(r.programs[sourceID]); err != nil {
		close(done)
		return nil, nil, fmt.Errorf("run %s: %w", sourceID, err)
	}
	return vm, done, nil
}

// Run gives the page to the source's script and returns what it made of each
// file, keyed by media URL.
//
// A script that fails is not an error: extraction is unaffected and the model
// answers as it did before. Breaking a crawl because somebody's regex threw
// would be a worse outcome than a slower one.
func (r *Runner) Run(ctx context.Context, sourceID string, page Page, items []Item) (map[string]Fields, error) {
	if !r.Has(sourceID) {
		return nil, nil
	}
	vm, done, err := r.start(ctx, sourceID)
	if err != nil {
		return nil, err
	}
	defer close(done)

	fn, ok := goja.AssertFunction(vm.Get("extract"))
	if !ok {
		return nil, fmt.Errorf("%s: no extract(page, items) function", sourceID)
	}
	out, err := fn(goja.Undefined(), vm.ToValue(page), vm.ToValue(items))
	if err != nil {
		return nil, fmt.Errorf("%s: %w", sourceID, err)
	}

	var fields []Fields
	if err := vm.ExportTo(out, &fields); err != nil {
		return nil, fmt.Errorf("%s: extract returned %v", sourceID, out)
	}
	by := make(map[string]Fields, len(fields))
	for _, f := range fields {
		if f.URL != "" {
			by[f.URL] = f
		}
	}
	return by, nil
}

// Links asks a source's script what a page points at.
//
// Only for sources whose pages do not carry links as such: a channel read by
// yt-dlp arrives as a list of video ids, and turning those into addresses is
// knowledge about YouTube rather than about crawling. A script without the
// function says nothing and the ordinary extraction stands.
func (r *Runner) Links(ctx context.Context, sourceID string, page Page) (Answer, error) {
	if !r.Has(sourceID) {
		return Answer{}, nil
	}
	vm, done, err := r.start(ctx, sourceID)
	if err != nil {
		return Answer{}, err
	}
	defer close(done)

	fn, ok := goja.AssertFunction(vm.Get("links"))
	if !ok {
		return Answer{}, nil
	}
	out, err := fn(goja.Undefined(), vm.ToValue(page))
	if err != nil {
		return Answer{}, fmt.Errorf("%s links: %w", sourceID, err)
	}
	var urls []string
	if err := vm.ExportTo(out, &urls); err != nil {
		return Answer{}, fmt.Errorf("%s: links returned %v", sourceID, out)
	}
	return Answer{Answered: true, URLs: urls}, nil
}

// Recordings asks a source's script what a page itself holds.
//
// Extraction finds a recording by the address of a file on the page. Some
// sources have no such file: a video page is the recording, and there is no
// separate thing to link to. A script says so; without the function the
// ordinary extraction stands.
func (r *Runner) Recordings(ctx context.Context, sourceID string, page Page) (Answer, error) {
	if !r.Has(sourceID) {
		return Answer{}, nil
	}
	vm, done, err := r.start(ctx, sourceID)
	if err != nil {
		return Answer{}, err
	}
	defer close(done)

	fn, ok := goja.AssertFunction(vm.Get("recordings"))
	if !ok {
		return Answer{}, nil
	}
	out, err := fn(goja.Undefined(), vm.ToValue(page))
	if err != nil {
		return Answer{}, fmt.Errorf("%s recordings: %w", sourceID, err)
	}
	var urls []string
	if err := vm.ExportTo(out, &urls); err != nil {
		return Answer{}, fmt.Errorf("%s: recordings returned %v", sourceID, out)
	}
	return Answer{Answered: true, URLs: urls}, nil
}
