package index_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jiva-studio/shruti/discovery/internal/application/index"
	"github.com/jiva-studio/shruti/discovery/internal/application/normalize"
	"github.com/jiva-studio/shruti/discovery/internal/application/script"
	"github.com/jiva-studio/shruti/discovery/internal/infra/fetch"
	"github.com/jiva-studio/shruti/discovery/internal/store"
)

// These run against a real Postgres, not a fake repository, because what is
// being checked is a property of the database: which write the next visit
// believes, and what an ON CONFLICT leaves behind when a pass fails halfway.
// A fake would answer whatever it was told and prove only that the code calls
// what its author thinks it calls.
//
// Without DISCOVERY_TEST_DATABASE_URL they skip. CI always sets it.
func testRepo(t *testing.T) *store.Repo {
	t.Helper()
	dsn := os.Getenv("DISCOVERY_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("DISCOVERY_TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := store.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(ctx, `DROP SCHEMA IF EXISTS discovery CASCADE`); err != nil {
		t.Fatalf("drop schema: %v", err)
	}
	if err := store.Migrate(ctx, pool); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return store.NewRepo(pool)
}

const talk = `<html><body>
	<h1>Bhagavad Gita 2.13</h1>
	<a href="/audio/bg-2-13.mp3">listen</a>
</body></html>`

// pageFetcher answers every address with the same document.
type pageFetcher struct {
	body  string
	reads int
}

func (f *pageFetcher) Get(_ context.Context, url string, _ fetch.Request) (*fetch.Response, error) {
	f.reads++
	sum := sha256.Sum256([]byte(f.body))
	return &fetch.Response{
		URL: url, Status: 200, ContentType: "text/html",
		Body: []byte(f.body), BodySHA256: hex.EncodeToString(sum[:]),
	}, nil
}

func (f *pageFetcher) Allowed(context.Context, string) bool { return true }

// brokenNormalizer is the provider having a bad minute: everything else about
// the page is readable, and the one call that costs money fails.
type brokenNormalizer struct{ normalize.Stub }

var errProvider = errors.New("provider said no")

func (brokenNormalizer) Normalize(context.Context, normalize.Batch) ([]normalize.Result, error) {
	return nil, errProvider
}

// A page whose recordings could not be stored must not be left claiming it was
// read. The validators are what the next visit compares; writing them before
// the recordings land is how one bad minute at a provider loses a listing page
// of recordings permanently, with nothing anywhere saying so.
func TestAFailedPassDoesNotMarkThePageDone(t *testing.T) {
	repo := testRepo(t)
	ctx := context.Background()
	now := time.Date(2026, time.August, 6, 12, 0, 0, 0, time.UTC)

	fetcher := &pageFetcher{body: talk}
	svc := &index.Service{
		Fetcher:    fetcher,
		Normalizer: brokenNormalizer{},
		Repo:       repo,
		Now:        func() time.Time { return now },
	}

	if _, err := svc.Item(ctx, "https://a.example/talk", "", false); !errors.Is(err, errProvider) {
		t.Fatalf("err = %v, want the provider's failure", err)
	}

	page, err := repo.PageByURL(ctx, "https://a.example/talk")
	if err != nil {
		t.Fatal(err)
	}
	if page == nil {
		t.Fatal("the visit left no page at all; the failure would be invisible")
	}
	if page.BodySHA256 != "" || page.ItemSetSHA256 != "" || page.NormPromptVersion != "" {
		t.Errorf("the page claims to have been read: body=%q items=%q prompt=%q",
			page.BodySHA256, page.ItemSetSHA256, page.NormPromptVersion)
	}
	if page.Error == "" {
		t.Error("nothing recorded why; the page reads as healthy")
	}

	// The proof: a second visit must do the work again rather than skip.
	before := fetcher.reads
	svc.Normalizer = normalize.Stub{}
	if _, err := svc.Item(ctx, "https://a.example/talk", "", false); err != nil {
		t.Fatal(err)
	}
	if fetcher.reads == before {
		t.Fatal("the page was not read again")
	}
	items, err := repo.ItemsByPage(ctx, page.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("stored %d recordings after the retry; the first failure lost them", len(items))
	}
}

// The other half of the same rule: a pass that succeeds must write the
// validators, or every page is re-read and re-normalized forever and the
// backoff never engages.
func TestASuccessfulPassIsSkippedNextTime(t *testing.T) {
	repo := testRepo(t)
	ctx := context.Background()
	now := time.Date(2026, time.August, 6, 12, 0, 0, 0, time.UTC)

	fetcher := &pageFetcher{body: talk}
	svc := &index.Service{
		Fetcher:    fetcher,
		Normalizer: normalize.Stub{},
		Repo:       repo,
		Now:        func() time.Time { return now },
	}

	if _, err := svc.Item(ctx, "https://a.example/talk", "", false); err != nil {
		t.Fatal(err)
	}
	page, err := repo.PageByURL(ctx, "https://a.example/talk")
	if err != nil {
		t.Fatal(err)
	}
	if page.BodySHA256 == "" || page.ItemSetSHA256 == "" || page.NormPromptVersion == "" {
		t.Fatalf("a completed pass left no proof: %+v", page)
	}

	report, err := svc.Item(ctx, "https://a.example/talk", "", false)
	if err != nil {
		t.Fatal(err)
	}
	if !report.Unchanged {
		t.Error("an unchanged page was read again in full; nothing would ever back off")
	}
}

// A failure that follows a good pass must not throw away the good pass's proof.
// SavePage coalesces an empty validator to what is stored, and this is the
// behaviour that rests on it: without it, one bad minute would demote a page
// that was already complete.
func TestAFailureKeepsTheLastCompletePassesProof(t *testing.T) {
	repo := testRepo(t)
	ctx := context.Background()
	now := time.Date(2026, time.August, 6, 12, 0, 0, 0, time.UTC)

	fetcher := &pageFetcher{body: talk}
	svc := &index.Service{
		Fetcher:    fetcher,
		Normalizer: normalize.Stub{},
		Repo:       repo,
		Now:        func() time.Time { return now },
	}
	if _, err := svc.Item(ctx, "https://a.example/talk", "", false); err != nil {
		t.Fatal(err)
	}
	good, err := repo.PageByURL(ctx, "https://a.example/talk")
	if err != nil {
		t.Fatal(err)
	}

	// The page changes, and this time the provider fails.
	fetcher.body = talk + `<a href="/audio/two.mp3">and</a>`
	svc.Normalizer = brokenNormalizer{}
	if _, err := svc.Item(ctx, "https://a.example/talk", "", true); !errors.Is(err, errProvider) {
		t.Fatalf("err = %v", err)
	}

	after, err := repo.PageByURL(ctx, "https://a.example/talk")
	if err != nil {
		t.Fatal(err)
	}
	if after.BodySHA256 != good.BodySHA256 || after.NormPromptVersion != good.NormPromptVersion {
		t.Errorf("the failed attempt overwrote the last good proof: %q/%q became %q/%q",
			good.BodySHA256, good.NormPromptVersion, after.BodySHA256, after.NormPromptVersion)
	}
}

// A speaker read by the model is written the way a speaker read by a script is
// written. They were not: the script path settled the name and the model path
// stored whatever the model said, so the same person appeared as "HH Radhanath
// Swami" from one page and "Radhanath Swami" from another. Grouping hid it,
// because the key is computed separately.
type namingNormalizer struct{ normalize.Stub }

func (namingNormalizer) Normalize(_ context.Context, b normalize.Batch) ([]normalize.Result, error) {
	out := make([]normalize.Result, len(b.Items))
	for i := range out {
		out[i] = normalize.Result{
			Title:   "Talk",
			Author:  "HH Radhanath Swami Maharaja",
			Authors: []string{"HH Radhanath Swami Maharaja", "Е.М. Ватсала прабху"},
		}
	}
	return out, nil
}

func TestAModelReadNameIsSettledLikeAScriptReadOne(t *testing.T) {
	repo := testRepo(t)
	ctx := context.Background()
	now := time.Date(2026, time.August, 7, 12, 0, 0, 0, time.UTC)

	svc := &index.Service{
		Fetcher:    &pageFetcher{body: talk},
		Normalizer: namingNormalizer{},
		Repo:       repo,
		Now:        func() time.Time { return now },
	}
	if _, err := svc.Item(ctx, "https://a.example/talk", "", false); err != nil {
		t.Fatal(err)
	}
	page, err := repo.PageByURL(ctx, "https://a.example/talk")
	if err != nil {
		t.Fatal(err)
	}
	items, err := repo.ItemsByPage(ctx, page.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("%d items", len(items))
	}
	if got := items[0].Author; got != "Radhanath Swami" {
		t.Errorf("author = %q, want %q", got, "Radhanath Swami")
	}
	// And the Cyrillic one is attached to a person, not dropped: "прабху" is a
	// form of address and comes off entirely, so the person is "Ватсала".
	authors, err := repo.Authors(ctx, "", 10)
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, a := range authors {
		if a.Name == "Ватсала" {
			found = true
		}
	}
	if !found {
		t.Errorf("no Cyrillic author was created: %+v", authors)
	}
}

// A personal channel names its speaker once, in the channel, and never again in
// the title of a talk. An aggregator's name is a temple and every talk on it is
// by somebody else — so this is stated per source, and it is the last word
// rather than the first.
type silentNormalizer struct{ normalize.Stub }

func (silentNormalizer) Normalize(_ context.Context, b normalize.Batch) ([]normalize.Result, error) {
	return make([]normalize.Result, len(b.Items)), nil
}

func TestTheSourcesDefaultAuthorFillsASilentPage(t *testing.T) {
	repo := testRepo(t)
	ctx := context.Background()
	now := time.Date(2026, time.August, 7, 12, 0, 0, 0, time.UTC)
	if err := repo.SaveSource(ctx, &store.Source{
		ID: "personal", SeedURLs: []string{"https://a.example/"}, Enabled: true,
		DefaultAuthor: "Е.С. Локанатха Свами Махарадж",
	}); err != nil {
		t.Fatal(err)
	}

	svc := &index.Service{
		Fetcher: &pageFetcher{body: talk}, Normalizer: silentNormalizer{},
		Repo: repo, Now: func() time.Time { return now },
	}
	if _, err := svc.Item(ctx, "https://a.example/talk", "personal", false); err != nil {
		t.Fatal(err)
	}
	page, _ := repo.PageByURL(ctx, "https://a.example/talk")
	items, err := repo.ItemsByPage(ctx, page.ID)
	if err != nil {
		t.Fatal(err)
	}
	// Settled on the way in, like any other name.
	if got := items[0].Author; got != "Локанатха Свами" {
		t.Errorf("author = %q, want %q", got, "Локанатха Свами")
	}
}

// And it must not overrule the page. A personal channel carrying a guest's
// lecture would otherwise file it under its owner — which is not hypothetical:
// one of these channels has two other swamis' lectures sitting among its own.
func TestTheDefaultAuthorNeverOverrulesThePage(t *testing.T) {
	repo := testRepo(t)
	ctx := context.Background()
	now := time.Date(2026, time.August, 7, 12, 0, 0, 0, time.UTC)
	if err := repo.SaveSource(ctx, &store.Source{
		ID: "personal", SeedURLs: []string{"https://a.example/"}, Enabled: true,
		DefaultAuthor: "Локанатха Свами",
	}); err != nil {
		t.Fatal(err)
	}

	svc := &index.Service{
		Fetcher: &pageFetcher{body: talk}, Normalizer: namingNormalizer{},
		Repo: repo, Now: func() time.Time { return now },
	}
	if _, err := svc.Item(ctx, "https://a.example/talk", "personal", false); err != nil {
		t.Fatal(err)
	}
	page, _ := repo.PageByURL(ctx, "https://a.example/talk")
	items, _ := repo.ItemsByPage(ctx, page.ID)
	if got := items[0].Author; got != "Radhanath Swami" {
		t.Errorf("author = %q; the source default overruled what the page said", got)
	}
}

// An archive of many speakers leaves it empty, and a page that names nobody
// stays nameless rather than being filed under a temple.
func TestAnAggregatorLeavesItEmpty(t *testing.T) {
	repo := testRepo(t)
	ctx := context.Background()
	now := time.Date(2026, time.August, 7, 12, 0, 0, 0, time.UTC)
	if err := repo.SaveSource(ctx, &store.Source{
		ID: "temple", SeedURLs: []string{"https://a.example/"}, Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	svc := &index.Service{
		Fetcher: &pageFetcher{body: talk}, Normalizer: silentNormalizer{},
		Repo: repo, Now: func() time.Time { return now },
	}
	if _, err := svc.Item(ctx, "https://a.example/talk", "temple", false); err != nil {
		t.Fatal(err)
	}
	page, _ := repo.PageByURL(ctx, "https://a.example/talk")
	items, _ := repo.ItemsByPage(ctx, page.ID)
	if got := items[0].Author; got != "" {
		t.Errorf("author = %q, want nobody", got)
	}
}

// A script is chosen by which script reads the source, not by which source it
// is. Those were the same thing, so one script served exactly one source, and
// fourteen YouTube channels read by one youtube.js were impossible: either
// fourteen copies of the script, or one source holding every channel — and then
// default_author, the one thing a source says about its speaker, is shared by
// all of them and useless.
func TestSeveralSourcesShareOneScript(t *testing.T) {
	repo := testRepo(t)
	ctx := context.Background()
	now := time.Date(2026, time.August, 7, 12, 0, 0, 0, time.UTC)

	// Two sources, neither named after a script, both naming the same one.
	for _, id := range []string{"channel-one", "channel-two"} {
		if err := repo.SaveSource(ctx, &store.Source{
			ID: id, SeedURLs: []string{"https://audioveda.ru/"}, Enabled: true,
			Script: "audioveda", DefaultAuthor: id,
		}); err != nil {
			t.Fatal(err)
		}
	}

	const page = `<html lang="ru"><body>
		<script type="application/ld+json">{"name":"Лекция","author":{"name":"Леонид Тугутов"},"datePublished":"2023-01-23"}</script>
		<div itemprop="transcript"><p>Текст лекции.</p></div>
		<a href="/audio/x.mp3">слушать</a></body></html>`

	runner, err := script.New()
	if err != nil {
		t.Fatal(err)
	}
	svc := &index.Service{
		Fetcher: &pageFetcher{body: page}, Normalizer: normalize.Stub{},
		Repo: repo, Scripts: runner, Now: func() time.Time { return now },
	}
	if _, err := svc.Item(ctx, "https://audioveda.ru/audios/1", "channel-one", false); err != nil {
		t.Fatal(err)
	}

	p, err := repo.PageByURL(ctx, "https://audioveda.ru/audios/1")
	if err != nil {
		t.Fatal(err)
	}
	items, err := repo.ItemsByPage(ctx, p.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("%d recordings", len(items))
	}
	// The script ran, so the archive's own words are here rather than a
	// filename turned into a title by the stub.
	if items[0].Title != "Лекция" || items[0].Author != "Леонид Тугутов" {
		t.Errorf("the script did not run for a source not named after it: %+v", items[0])
	}
	if p.ScriptVersion == "" {
		t.Error("no script version recorded, so editing the script would change nothing")
	}
}

// A source named after its script keeps working with nothing set, which is how
// idt and audioveda have always been configured.
func TestASourceNamedAfterItsScriptStillWorks(t *testing.T) {
	repo := testRepo(t)
	ctx := context.Background()
	now := time.Date(2026, time.August, 7, 12, 0, 0, 0, time.UTC)
	if err := repo.SaveSource(ctx, &store.Source{
		ID: "audioveda", SeedURLs: []string{"https://audioveda.ru/"}, Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}
	runner, err := script.New()
	if err != nil {
		t.Fatal(err)
	}
	const page = `<html lang="ru"><body>
		<script type="application/ld+json">{"name":"Лекция","author":{"name":"Леонид Тугутов"},"datePublished":"2023-01-23"}</script>
		<a href="/audio/x.mp3">слушать</a></body></html>`
	svc := &index.Service{
		Fetcher: &pageFetcher{body: page}, Normalizer: normalize.Stub{},
		Repo: repo, Scripts: runner, Now: func() time.Time { return now },
	}
	if _, err := svc.Item(ctx, "https://audioveda.ru/audios/1", "audioveda", false); err != nil {
		t.Fatal(err)
	}
	p, _ := repo.PageByURL(ctx, "https://audioveda.ru/audios/1")
	items, _ := repo.ItemsByPage(ctx, p.ID)
	if len(items) != 1 || items[0].Title != "Лекция" {
		t.Errorf("= %+v", items)
	}
}
