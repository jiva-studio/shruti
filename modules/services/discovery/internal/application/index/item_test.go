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
