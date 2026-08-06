package crawl_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"testing"
	"time"

	"github.com/jiva-studio/lectorium/discovery/internal/application/crawl"
	"github.com/jiva-studio/lectorium/discovery/internal/application/index"
	"github.com/jiva-studio/lectorium/discovery/internal/application/normalize"
	"github.com/jiva-studio/lectorium/discovery/internal/infra/fetch"
	"github.com/jiva-studio/lectorium/discovery/internal/store"
)

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

// heldFetcher answers only once released, so a page can be caught mid-visit.
type heldFetcher struct {
	entered chan struct{}
	release chan struct{}
	// seen is the context the work was done under, kept so the test can ask
	// whether shutting down cancelled it.
	seen context.Context
}

func (f *heldFetcher) Get(ctx context.Context, url string, _ fetch.Request) (*fetch.Response, error) {
	f.seen = ctx
	select {
	case f.entered <- struct{}{}:
	default:
	}
	<-f.release
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	body := `<html><body><h1>Talk</h1><a href="/a.mp3">listen</a></body></html>`
	sum := sha256.Sum256([]byte(body))
	return &fetch.Response{
		URL: url, Status: 200, ContentType: "text/html",
		Body: []byte(body), BodySHA256: hex.EncodeToString(sum[:]),
	}, nil
}

func (f *heldFetcher) Allowed(context.Context, string) bool { return true }

// Shutting down must stop the scheduler taking new pages without cancelling the
// one already being written.
//
// It used to cancel the context and then wait, which is the same context every
// pgx call in the write path runs under — so the wait was for wreckage, and a
// deploy during a crawl dropped whatever was in flight.
func TestStoppingDoesNotCancelTheWorkInHand(t *testing.T) {
	repo := testRepo(t)
	ctx := context.Background()

	if err := repo.SaveSource(ctx, &store.Source{
		ID: "a", SeedURLs: []string{"https://a.example/talk"}, Enabled: true,
	}); err != nil {
		t.Fatal(err)
	}

	f := &heldFetcher{entered: make(chan struct{}, 1), release: make(chan struct{})}
	now := time.Date(2026, time.August, 6, 12, 0, 0, 0, time.UTC)
	idx := &index.Service{
		Fetcher: f, Normalizer: normalize.Stub{}, Repo: repo,
		Now: func() time.Time { return now },
	}
	s := crawl.NewScheduler(idx, repo, f, 1, 0)

	done := make(chan struct{})
	go func() { defer close(done); s.Run(ctx) }()

	select {
	case <-f.entered:
	case <-time.After(10 * time.Second):
		t.Fatal("the scheduler never picked the seed up")
	}

	s.Stop()

	// The page is still mid-visit. If Stop cancelled the work, this is where it
	// shows: the context the fetch is holding would already be done.
	if err := f.seen.Err(); err != nil {
		t.Fatalf("stopping cancelled the visit in flight: %v", err)
	}
	close(f.release)

	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatal("the scheduler did not stop")
	}

	page, err := repo.PageByURL(ctx, "https://a.example/talk")
	if err != nil {
		t.Fatal(err)
	}
	if page == nil {
		t.Fatal("the page in flight was lost")
	}
	if page.BodySHA256 == "" || page.NormPromptVersion == "" {
		t.Errorf("the visit was cut short: %+v", page)
	}
	items, err := repo.ItemsByPage(ctx, page.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Errorf("stored %d recordings; the write did not finish", len(items))
	}
}

// A scheduler that is stopped while waiting for work must not sit out the idle
// wait first. Fifteen seconds of nothing, every deploy, is how a drain budget
// gets spent on an empty queue.
func TestStoppingAnIdleSchedulerIsImmediate(t *testing.T) {
	repo := testRepo(t)
	s := crawl.NewScheduler(nil, repo, nil, 1, 0)

	done := make(chan struct{})
	go func() { defer close(done); s.Run(context.Background()) }()

	// Nothing is enabled, so the first claim comes back empty and it rests.
	time.Sleep(200 * time.Millisecond)
	s.Stop()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("stopping waited out the idle interval")
	}
}
