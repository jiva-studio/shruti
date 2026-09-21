package parse_test

import (
	"context"
	"errors"
	"testing"

	"github.com/jiva-studio/shruti/discovery/internal/application/normalize"
	"github.com/jiva-studio/shruti/discovery/internal/application/parse"
	"github.com/jiva-studio/shruti/discovery/internal/infra/fetch"
)

// The dry run is what somebody points at a new archive to find out whether this
// service can read it, before anything is stored or anybody's site is crawled.
// So what matters is that it shows the layers separately — what came off the
// page, what the model is asked, what it said — and that the middle one is
// there even when there is no model at all. That is the whole no-key path.

type fakeFetcher struct {
	resp *fetch.Response
	err  error
	// asked records what the fetcher was given, so the source's credentials and
	// pace can be shown to reach it.
	asked fetch.Request
	url   string
}

func (f *fakeFetcher) Get(_ context.Context, url string, req fetch.Request) (*fetch.Response, error) {
	f.url, f.asked = url, req
	return f.resp, f.err
}

const page = `<html><body>
	<h1>Bhagavad Gita 2.13</h1>
	<p>A class given in Chowpatty.</p>
	<a href="/audio/bg-2-13.mp3">listen</a>
	<a href="/more">more talks</a>
</body></html>`

func htmlResponse(body string) *fetch.Response {
	return &fetch.Response{
		URL: "https://a.example/talk", Status: 200,
		ContentType: "text/html", Body: []byte(body),
	}
}

// Without a model the first two layers still come out, which is what makes the
// dry run useful with no key at all.
func TestExtractionWorksWithoutAModel(t *testing.T) {
	f := &fakeFetcher{resp: htmlResponse(page)}
	svc := &parse.Service{Fetcher: f}

	got, err := svc.URL(t.Context(), "https://a.example/talk", fetch.Request{})
	if err != nil {
		t.Fatal(err)
	}
	if got.Extracted == nil || len(got.Extracted.Items) != 1 {
		t.Fatalf("extracted %+v, want the one audio file", got.Extracted)
	}
	if got.Extracted.Items[0].MediaURL != "https://a.example/audio/bg-2-13.mp3" {
		t.Errorf("media = %q; a relative address was not resolved", got.Extracted.Items[0].MediaURL)
	}
	if len(got.NormalizerInput.Items) != 1 {
		t.Errorf("nothing to show the model: %+v", got.NormalizerInput)
	}
	if got.Normalized != nil {
		t.Errorf("answers with no model configured: %+v", got.Normalized)
	}
	if got.Status != 200 || got.ContentType != "text/html" {
		t.Errorf("status=%d type=%q", got.Status, got.ContentType)
	}
}

// The hashes are what make an unchanged page cost no model call, so a dry run
// has to show them: one per file, in the order the files are in.
func TestTheHashesAreShownOnePerFile(t *testing.T) {
	f := &fakeFetcher{resp: htmlResponse(page + `<a href="/audio/two.mp3">and</a>`)}
	svc := &parse.Service{Fetcher: f, Normalizer: normalize.Stub{}}

	got, err := svc.URL(t.Context(), "https://a.example/talk", fetch.Request{})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.InputHashes) != len(got.Extracted.Items) {
		t.Fatalf("%d hashes for %d files", len(got.InputHashes), len(got.Extracted.Items))
	}
	for i, h := range got.InputHashes {
		if h == "" {
			t.Errorf("file %d has no hash; it would be re-read on every pass", i)
		}
	}
	if len(got.InputHashes) == 2 && got.InputHashes[0] == got.InputHashes[1] {
		t.Error("two different files hashed the same; one would stand in for the other")
	}
}

// A source's credentials and its pace reach the fetcher. A page behind an
// account shows its files only to somebody signed in, so a dry run that dropped
// them would report an empty archive.
func TestTheSourcesCredentialsAndPaceAreCarried(t *testing.T) {
	f := &fakeFetcher{resp: htmlResponse(page)}
	svc := &parse.Service{Fetcher: f}
	req := fetch.Request{
		Headers: map[string]string{"Cookie": "session=abc"},
		Tool:    "ytdlp",
	}

	if _, err := svc.URL(t.Context(), "https://a.example/talk", req); err != nil {
		t.Fatal(err)
	}
	if f.url != "https://a.example/talk" {
		t.Errorf("fetched %q", f.url)
	}
	if f.asked.Headers["Cookie"] != "session=abc" || f.asked.Tool != "ytdlp" {
		t.Errorf("the fetcher was given %+v", f.asked)
	}
}

// Being refused is the answer, not something to paper over: a dry run that
// reported an empty page for a 403 would look like an archive with nothing in
// it.
func TestAFetchFailureIsNotAnEmptyPage(t *testing.T) {
	f := &fakeFetcher{err: fetch.ErrDisallowed}
	svc := &parse.Service{Fetcher: f}

	got, err := svc.URL(t.Context(), "https://a.example/talk", fetch.Request{})
	if !errors.Is(err, fetch.ErrDisallowed) {
		t.Fatalf("= %+v, %v", got, err)
	}
	if got != nil {
		t.Errorf("layers came back alongside the refusal: %+v", got)
	}
}

func TestNoFetcherSaysSo(t *testing.T) {
	svc := &parse.Service{}
	if _, err := svc.URL(t.Context(), "https://a.example/", fetch.Request{}); err == nil {
		t.Error("an unconfigured service reported success")
	}
}

// Body is the same path without the network, so extraction can be worked on
// against a page somebody already saved.
func TestBodyNeedsNoFetcherAtAll(t *testing.T) {
	svc := &parse.Service{}

	got, err := svc.Body(t.Context(), []byte(page), "text/html", "https://a.example/talk")
	if err != nil {
		t.Fatal(err)
	}
	if got.Extracted == nil || len(got.Extracted.Items) != 1 {
		t.Fatalf("extracted %+v", got.Extracted)
	}
}

// A page with no audio on it is a real answer and a common one — most of any
// site is menus.
func TestAPageWithNoAudioIsNotAnError(t *testing.T) {
	f := &fakeFetcher{resp: htmlResponse(`<html><body><a href="/more">more</a></body></html>`)}
	svc := &parse.Service{Fetcher: f}

	got, err := svc.URL(t.Context(), "https://a.example/menu", fetch.Request{})
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Extracted.Items) != 0 {
		t.Errorf("found %d files on a menu", len(got.Extracted.Items))
	}
	if len(got.Extracted.Links) == 0 {
		t.Error("a page that is only links reported none; the crawl would stop here")
	}
}
