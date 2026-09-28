package crawl_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sync"
	"testing"
	"time"

	"github.com/jiva-studio/shruti/discovery/internal/application/crawl"
	"github.com/jiva-studio/shruti/discovery/internal/application/index"
	"github.com/jiva-studio/shruti/discovery/internal/application/normalize"
	"github.com/jiva-studio/shruti/discovery/internal/application/parse"
	"github.com/jiva-studio/shruti/discovery/internal/domain"
)

// siteFetcher serves a small site from memory; anything else is gone.
type siteFetcher struct {
	mu    sync.Mutex
	pages map[string]string
	asked []string
}

func (f *siteFetcher) Get(_ context.Context, url string, _ domain.FetchRequest) (*domain.FetchResponse, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.asked = append(f.asked, url)
	body, ok := f.pages[url]
	if !ok {
		return nil, domain.ErrGone
	}
	sum := sha256.Sum256([]byte(body))
	return &domain.FetchResponse{
		URL: url, Status: 200, ContentType: "text/html",
		Body: []byte(body), BodySHA256: hex.EncodeToString(sum[:]),
	}, nil
}

func (f *siteFetcher) Allowed(context.Context, string) bool { return true }

func (f *siteFetcher) wasAsked(url string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, u := range f.asked {
		if u == url {
			return true
		}
	}
	return false
}

func smallSite() *siteFetcher {
	return &siteFetcher{pages: map[string]string{
		"https://a.example/talks/": `<html><body>
			<a href="/talks/one">one</a>
			<a href="/talks/two">two</a></body></html>`,
		"https://a.example/talks/one": `<html><body><a href="/audio/one.mp3">listen</a></body></html>`,
		"https://a.example/talks/two": `<html><body><a href="/audio/two.mp3">listen</a></body></html>`,
	}}
}

// A pass walks from the seed through the links it finds, indexes what each page
// offers, and closes its run with the tally.
func TestAPassWalksTheSourceAndClosesItsRun(t *testing.T) {
	repo := testRepo(t)
	ctx := t.Context()
	src := &domain.Archive{ID: "a", SeedURLs: []string{"https://a.example/talks/"}, Enabled: true, CrawlWorkers: 1}
	if err := repo.SaveSource(ctx, src); err != nil {
		t.Fatal(err)
	}
	f := smallSite()
	now := time.Date(2026, time.August, 6, 12, 0, 0, 0, time.UTC)
	svc := &crawl.Service{
		Index:   &index.Service{Fetcher: f, Normalizer: normalize.Stub{}, Store: repo, Now: func() time.Time { return now }},
		Parse:   &parse.Service{Fetcher: f, Normalizer: normalize.Stub{}},
		Fetcher: f,
		Repo:    repo,
		Now:     func() time.Time { return now },
	}

	run, err := svc.Begin(ctx, src, crawl.Options{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if run.ID == 0 {
		t.Fatal("the run was not recorded before the walk")
	}
	if err := svc.Resume(ctx, src, crawl.Options{Limit: 10}, run); err != nil {
		t.Fatal(err)
	}
	if run.PagesFetched != 3 || run.ItemsFound != 2 || run.ItemsNew != 2 || run.Failures != 0 {
		t.Errorf("run = fetched %d, found %d, new %d, failed %d; want 3, 2, 2, 0",
			run.PagesFetched, run.ItemsFound, run.ItemsNew, run.Failures)
	}

	stored, err := repo.Run(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.FinishedAt == nil || stored.PagesFetched != 3 || stored.ItemsNew != 2 {
		t.Errorf("stored run = %+v", stored)
	}

	// The next ordinary pass honours the schedule: nothing is due, so the
	// pages it already read are not fetched again.
	f.asked = nil
	again, err := svc.Begin(ctx, src, crawl.Options{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Resume(ctx, src, crawl.Options{Limit: 10}, again); err != nil {
		t.Fatal(err)
	}
	if f.wasAsked("https://a.example/talks/one") {
		t.Error("a page that is not due was fetched again")
	}
}

// A pass whose pages fail counts the failures by kind and still closes.
func TestAPassCountsItsFailures(t *testing.T) {
	repo := testRepo(t)
	ctx := t.Context()
	src := &domain.Archive{ID: "a", SeedURLs: []string{"https://a.example/talks/"}, Enabled: true, CrawlWorkers: 1}
	if err := repo.SaveSource(ctx, src); err != nil {
		t.Fatal(err)
	}
	f := smallSite()
	delete(f.pages, "https://a.example/talks/two")
	svc := &crawl.Service{
		Index:   &index.Service{Fetcher: f, Normalizer: normalize.Stub{}, Store: repo},
		Fetcher: f,
		Repo:    repo,
	}
	run, err := svc.Begin(ctx, src, crawl.Options{Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Resume(ctx, src, crawl.Options{Limit: 10}, run); err != nil {
		t.Fatal(err)
	}
	if run.PagesFetched != 2 || run.Failures != 1 || run.Errors["gone"] != 1 {
		t.Errorf("run = fetched %d, failed %d, errors %v", run.PagesFetched, run.Failures, run.Errors)
	}
}

// A dry run reads and follows links but records nothing: no run row, no pages.
func TestADryRunWritesNothing(t *testing.T) {
	repo := testRepo(t)
	ctx := t.Context()
	src := &domain.Archive{ID: "a", SeedURLs: []string{"https://a.example/talks/"}, Enabled: true, CrawlWorkers: 1}
	if err := repo.SaveSource(ctx, src); err != nil {
		t.Fatal(err)
	}
	f := smallSite()
	svc := &crawl.Service{
		Index:   &index.Service{Fetcher: f, Normalizer: normalize.Stub{}, Store: repo},
		Parse:   &parse.Service{Fetcher: f, Normalizer: normalize.Stub{}},
		Fetcher: f,
		Repo:    repo,
	}
	opts := crawl.Options{DryRun: true, Limit: 10}
	run, err := svc.Begin(ctx, src, opts)
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Resume(ctx, src, opts, run); err != nil {
		t.Fatal(err)
	}
	if run.PagesFetched != 3 || run.ItemsFound != 2 {
		t.Errorf("dry run = fetched %d, found %d; want 3, 2", run.PagesFetched, run.ItemsFound)
	}
	runs, err := repo.Runs(ctx, "a", 10)
	if err != nil {
		t.Fatal(err)
	}
	page, err := repo.PageByURL(ctx, "https://a.example/talks/one")
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 0 || page != nil {
		t.Errorf("a dry run left %d runs and page %+v", len(runs), page)
	}
}
