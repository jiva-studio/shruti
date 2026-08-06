package store_test

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti/discovery/internal/store"
)

// Almost everything this service does is I/O, and for a long time none of it
// was tested: the pure parts were covered and the store was not, which is where
// the defects turned out to live. These run against a real Postgres with
// pgvector, because the things worth checking — a claim that must not starve
// itself, a write that must survive two workers, a key that must hold several
// languages — are properties of the database and not of Go.
//
// Without DISCOVERY_TEST_DATABASE_URL they skip. CI always sets it.
func testRepo(t *testing.T) (*store.Repo, *pgxpool.Pool) {
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

	// Each test starts from nothing. Dropping rather than truncating also means
	// the migrations themselves are exercised on every run.
	if _, err := pool.Exec(ctx, `DROP SCHEMA IF EXISTS discovery CASCADE`); err != nil {
		t.Fatalf("drop schema: %v", err)
	}
	if err := store.Migrate(ctx, pool); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if err := store.SchemaReady(ctx, pool); err != nil {
		t.Fatalf("schema not ready: %v", err)
	}
	return store.NewRepo(pool), pool
}

func mustSource(t *testing.T, r *store.Repo, s *store.Source) {
	t.Helper()
	if err := r.SaveSource(context.Background(), s); err != nil {
		t.Fatalf("save source %s: %v", s.ID, err)
	}
}

func mustPage(t *testing.T, r *store.Repo, p *store.Page) int64 {
	t.Helper()
	id, err := r.SavePage(context.Background(), p)
	if err != nil {
		t.Fatalf("save page %s: %v", p.URL, err)
	}
	return id
}

// A source with nothing behind it yet is started from its seeds, and only from
// them: once one page exists the links carry it forward, and claiming the seed
// after that loops, because a seed that redirects is stored under the address
// it redirected to and never matches the one in the config.
func TestClaimStartsFromSeedsAndThenStops(t *testing.T) {
	r, _ := testRepo(t)
	ctx, now := context.Background(), time.Now().UTC()
	mustSource(t, r, &store.Source{
		ID: "a", SeedURLs: []string{"https://a.example/start"}, Enabled: true,
	})

	got, err := r.ClaimWork(ctx, now, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].URL != "https://a.example/start" || got[0].SourceID != "a" {
		t.Fatalf("first claim = %+v, want the seed", got)
	}

	later := now.Add(time.Hour)
	mustPage(t, r, &store.Page{
		URL: "https://a.example/landed", SourceID: ptr("a"), NextCheckAt: &later,
	})
	if got, err := r.ClaimWork(ctx, now, 10); err != nil || len(got) != 0 {
		t.Fatalf("second claim = %+v (err %v), want nothing: the source has a page now", got, err)
	}
}

// New addresses come before rechecks. They are the reason a listing was re-read
// at all, and a queue that served the oldest recheck first would leave what was
// just discovered waiting behind a decade of archive.
func TestNewAddressesComeBeforeRechecks(t *testing.T) {
	r, _ := testRepo(t)
	ctx, now := context.Background(), time.Now().UTC()
	mustSource(t, r, &store.Source{ID: "a", SeedURLs: []string{"https://a.example/"}, Enabled: true})

	long := now.Add(-48 * time.Hour)
	listing := mustPage(t, r, &store.Page{
		URL: "https://a.example/listing", SourceID: ptr("a"), NextCheckAt: &long,
	})
	if err := r.ReplacePageLinks(ctx, listing, []string{"https://a.example/new"}); err != nil {
		t.Fatal(err)
	}

	got, err := r.ClaimWork(ctx, now, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("claimed %d, want the new address and the overdue listing", len(got))
	}
	if got[0].URL != "https://a.example/new" {
		t.Errorf("first = %q, want the address nobody has visited", got[0].URL)
	}
}

// The page that has been waiting longest goes first. It sorted the other way
// round for a while — the least overdue served first — which with a backlog
// bigger than throughput means the pages waiting longest are served last, every
// time, and a page far enough behind is never read at all.
func TestTheLongestWaitingPageGoesFirst(t *testing.T) {
	r, _ := testRepo(t)
	ctx, now := context.Background(), time.Now().UTC()
	mustSource(t, r, &store.Source{ID: "a", SeedURLs: []string{"https://a.example/"}, Enabled: true})
	// A seed exists, so a page must too, or the seed branch claims the source.
	recent := now.Add(-time.Minute)
	ancient := now.Add(-30 * 24 * time.Hour)
	middling := now.Add(-2 * time.Hour)
	for url, due := range map[string]time.Time{
		"https://a.example/recent":   recent,
		"https://a.example/ancient":  ancient,
		"https://a.example/middling": middling,
	} {
		mustPage(t, r, &store.Page{URL: url, SourceID: ptr("a"), NextCheckAt: &due})
	}

	got, err := r.ClaimWork(ctx, now, 10)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"https://a.example/ancient",
		"https://a.example/middling",
		"https://a.example/recent",
	}
	if len(got) != len(want) {
		t.Fatalf("claimed %d, want %d", len(got), len(want))
	}
	for i, w := range want {
		if got[i].URL != w {
			t.Errorf("position %d = %q, want %q — the queue is serving the wrong end", i, got[i].URL, w)
		}
	}
}

// A source nobody has walked comes before anything else. Its seed is the only
// work it can offer, and behind a long backlog it would never be read.
func TestAnUnwalkedSourceStartsFirst(t *testing.T) {
	r, _ := testRepo(t)
	ctx, now := context.Background(), time.Now().UTC()
	mustSource(t, r, &store.Source{ID: "old", SeedURLs: []string{"https://old.example/"}, Enabled: true})
	mustSource(t, r, &store.Source{ID: "new", SeedURLs: []string{"https://new.example/"}, Enabled: true})

	long := now.Add(-48 * time.Hour)
	listing := mustPage(t, r, &store.Page{
		URL: "https://old.example/listing", SourceID: ptr("old"), NextCheckAt: &long,
	})
	if err := r.ReplacePageLinks(ctx, listing, []string{"https://old.example/link"}); err != nil {
		t.Fatal(err)
	}

	got, err := r.ClaimWork(ctx, now, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) == 0 || got[0].URL != "https://new.example/" {
		t.Errorf("first = %+v, want the seed of the source with no pages", got)
	}
}

// A page that keeps failing was visible nowhere: a run's error tally is
// per-run and gone on restart, and the empty-pages list files a real failure
// alongside every menu on the site.
func TestFailingPagesAreTheirOwnList(t *testing.T) {
	r, _ := testRepo(t)
	ctx, now := context.Background(), time.Now().UTC()
	mustSource(t, r, &store.Source{ID: "a", SeedURLs: []string{"https://a.example/"}, Enabled: true})

	mustPage(t, r, &store.Page{URL: "https://a.example/menu", SourceID: ptr("a"),
		NextCheckAt: &now, MediaFound: 0})
	mustPage(t, r, &store.Page{URL: "https://a.example/blip", SourceID: ptr("a"),
		NextCheckAt: &now, Error: "http 500", ConsecutiveFailures: 1})
	mustPage(t, r, &store.Page{URL: "https://a.example/dead", SourceID: ptr("a"),
		NextCheckAt: &now, Error: "http 404", ConsecutiveFailures: 40})

	failing, err := r.FailingPages(ctx, "a", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(failing) != 2 {
		t.Fatalf("listed %d, want the two that failed and not the menu", len(failing))
	}
	if failing[0].URL != "https://a.example/dead" {
		t.Errorf("first = %q, want the worst one", failing[0].URL)
	}
	if failing[0].ConsecutiveFailures != 40 {
		t.Errorf("failure count = %d, want 40", failing[0].ConsecutiveFailures)
	}

	// The empty-pages view still answers its own question, which is a different
	// one: we were there and came away with nothing.
	empty, err := r.EmptyPages(ctx, "a", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(empty) != 3 {
		t.Errorf("empty pages = %d, want all three", len(empty))
	}
}

// A disabled source is not touched. Manual runs are a different matter and use
// DuePages, which deliberately does not filter this way.
func TestDisabledSourceIsNotClaimed(t *testing.T) {
	r, _ := testRepo(t)
	ctx, now := context.Background(), time.Now().UTC()
	mustSource(t, r, &store.Source{ID: "off", SeedURLs: []string{"https://off.example/"}})
	overdue := now.Add(-time.Hour)
	mustPage(t, r, &store.Page{
		URL: "https://off.example/page", SourceID: ptr("off"), NextCheckAt: &overdue,
	})

	got, err := r.ClaimWork(ctx, now, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Errorf("claimed %+v from a source that is switched off", got)
	}
	due, err := r.DuePages(ctx, "off", now, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(due) != 1 {
		t.Errorf("a hand-run over a disabled source found %d pages, want 1", len(due))
	}
}

// The defect this guards: a page we are not allowed to fetch used to keep
// filling the claim and be discarded afterwards, so a pass came back empty
// while there was plenty waiting. Taking it out of the queue is what ends that.
func TestUnreachablePageLeavesTheQueue(t *testing.T) {
	r, _ := testRepo(t)
	ctx, now := context.Background(), time.Now().UTC()
	mustSource(t, r, &store.Source{ID: "a", SeedURLs: []string{"https://a.example/"}, Enabled: true})
	overdue := now.Add(-time.Hour)
	url := "https://a.example/api/closed"
	mustPage(t, r, &store.Page{URL: url, SourceID: ptr("a"), NextCheckAt: &overdue})

	if got, _ := r.ClaimWork(ctx, now, 10); len(got) != 1 {
		t.Fatalf("claimed %d before, want 1", len(got))
	}
	if err := r.Unreachable(ctx, url, "disallowed by robots.txt", now); err != nil {
		t.Fatal(err)
	}

	got, err := r.ClaimWork(ctx, now, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Errorf("claimed %+v after the page was put out of reach", got)
	}
	if due, _ := r.DuePages(ctx, "a", now, 10); len(due) != 0 {
		t.Errorf("a hand-run still sees %d unreachable pages", len(due))
	}

	var reason string
	if err := r.Pool().QueryRow(ctx,
		`SELECT coalesce(error,'') FROM discovery.pages WHERE url = $1`, url).Scan(&reason); err != nil {
		t.Fatal(err)
	}
	if reason == "" {
		t.Error("a page taken out of the queue must say why")
	}
}

// One recording, several transcripts. The key used to be (item_id, kind), so
// the second language displaced the first instead of joining it.
func TestARecordingHoldsATranscriptPerLanguage(t *testing.T) {
	r, _ := testRepo(t)
	ctx := context.Background()
	item := seedItem(t, r)

	texts := []store.ItemText{
		{Lang: "en", Text: "in the beginning"},
		{Lang: "ru", Text: "в начале"},
	}
	if err := r.ReplaceItemTexts(ctx, item, store.ChunkPageText, texts); err != nil {
		t.Fatal(err)
	}

	got := itemTexts(t, r, item)
	if len(got) != 2 || got["en"] != "in the beginning" || got["ru"] != "в начале" {
		t.Fatalf("stored %v, want both languages", got)
	}

	// A translation the archive has withdrawn stops being searchable. Left to
	// accumulate it would go on answering for ever with nothing to say it was
	// taken down.
	if err := r.ReplaceItemTexts(ctx, item, store.ChunkPageText,
		[]store.ItemText{{Lang: "en", Text: "in the beginning"}}); err != nil {
		t.Fatal(err)
	}
	if got := itemTexts(t, r, item); len(got) != 1 || got["ru"] != "" {
		t.Errorf("after the withdrawal: %v, want only en", got)
	}
}

// Chunks carry the language of the text they came from, so a hit can say which
// transcript it is quoting.
func TestChunksKeepTheirLanguage(t *testing.T) {
	r, _ := testRepo(t)
	ctx := context.Background()
	item := seedItem(t, r)

	err := r.ReplaceItemChunks(ctx, item, []store.Chunk{
		{ItemID: item, Kind: store.ChunkTitle, Lang: "en", Text: "A talk"},
		{ItemID: item, Kind: store.ChunkPageText, Lang: "ru", Ordinal: 0, Text: "в начале"},
	})
	if err != nil {
		t.Fatal(err)
	}

	rows, err := r.Pool().Query(ctx,
		`SELECT kind, lang FROM discovery.chunks WHERE item_id = $1 ORDER BY kind`, item)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	got := map[string]string{}
	for rows.Next() {
		var kind, lang string
		if err := rows.Scan(&kind, &lang); err != nil {
			t.Fatal(err)
		}
		got[kind] = lang
	}
	if got[store.ChunkTitle] != "en" || got[store.ChunkPageText] != "ru" {
		t.Errorf("chunk languages = %v", got)
	}
}

// Two workers given the same page is not hypothetical: it is what the scheduler
// did on its first live run, and one of them lost on the primary key.
func TestTwoWritersOnOnePageDoNotCollide(t *testing.T) {
	r, _ := testRepo(t)
	ctx := context.Background()
	mustSource(t, r, &store.Source{ID: "a", SeedURLs: []string{"https://a.example/"}, Enabled: true})
	page := mustPage(t, r, &store.Page{URL: "https://a.example/listing", SourceID: ptr("a")})
	links := []string{"https://a.example/one", "https://a.example/two"}

	errs := make(chan error, 2)
	for range 2 {
		go func() { errs <- r.ReplacePageLinks(ctx, page, links) }()
	}
	for range 2 {
		if err := <-errs; err != nil {
			t.Fatalf("concurrent write: %v", err)
		}
	}

	stored, err := r.PageLinks(ctx, page)
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != 2 {
		t.Errorf("stored %d links, want 2", len(stored))
	}
}

// A source states its own recheck bounds; a source that states nothing gets the
// numbers the column defaults carry, never zero — which would be a crawler
// asking for the same page as fast as a site can answer.
func TestSourceRecheckBoundsRoundTrip(t *testing.T) {
	r, _ := testRepo(t)
	ctx := context.Background()

	mustSource(t, r, &store.Source{ID: "quiet", SeedURLs: []string{"https://q.example/"},
		RecheckMinS: 7 * 24 * 60 * 60, RecheckMaxS: 30 * 24 * 60 * 60})
	mustSource(t, r, &store.Source{ID: "plain", SeedURLs: []string{"https://p.example/"}})

	quiet, err := r.Source(ctx, "quiet")
	if err != nil {
		t.Fatal(err)
	}
	if quiet.RecheckMinS != 7*24*60*60 {
		t.Errorf("min = %d, want a week", quiet.RecheckMinS)
	}
	plain, err := r.Source(ctx, "plain")
	if err != nil {
		t.Fatal(err)
	}
	if plain.RecheckMinS <= 0 || plain.RecheckMaxS < plain.RecheckMinS {
		t.Errorf("defaults are nonsense: min=%d max=%d", plain.RecheckMinS, plain.RecheckMaxS)
	}
}

// Credentials go in and are not displaced by an ordinary edit. Saving a source
// without them used to sign it out silently.
func TestAnEditDoesNotSignASourceOut(t *testing.T) {
	r, _ := testRepo(t)
	ctx := context.Background()

	mustSource(t, r, &store.Source{ID: "a", SeedURLs: []string{"https://a.example/"},
		AuthHeaders: map[string]string{"Cookie": "session=abc"}})
	mustSource(t, r, &store.Source{ID: "a", SeedURLs: []string{"https://a.example/", "https://a.example/more"}})

	got, err := r.Source(ctx, "a")
	if err != nil {
		t.Fatal(err)
	}
	if got.AuthHeaders["Cookie"] != "session=abc" {
		t.Errorf("credentials after an edit = %v", got.AuthHeaders)
	}
	if len(got.SeedURLs) != 2 {
		t.Errorf("the edit itself did not take: %v", got.SeedURLs)
	}
}

// The queue depth is what an operator looks at to know whether anything is
// waiting, so it has to count both halves of the queue.
func TestQueueDepthCountsBothKindsOfWork(t *testing.T) {
	r, _ := testRepo(t)
	ctx, now := context.Background(), time.Now().UTC()
	mustSource(t, r, &store.Source{ID: "a", SeedURLs: []string{"https://a.example/"}, Enabled: true})

	overdue := now.Add(-time.Hour)
	page := mustPage(t, r, &store.Page{
		URL: "https://a.example/listing", SourceID: ptr("a"), NextCheckAt: &overdue,
	})
	if err := r.ReplacePageLinks(ctx, page, []string{"https://a.example/new"}); err != nil {
		t.Fatal(err)
	}

	depth, err := r.QueueDepth(ctx, now)
	if err != nil {
		t.Fatal(err)
	}
	if depth != 2 {
		t.Errorf("depth = %d, want the overdue page and the unvisited link", depth)
	}
}

func seedItem(t *testing.T, r *store.Repo) int64 {
	t.Helper()
	ctx := context.Background()
	mustSource(t, r, &store.Source{ID: "a", SeedURLs: []string{"https://a.example/"}, Enabled: true})
	page := mustPage(t, r, &store.Page{URL: "https://a.example/talk", SourceID: ptr("a")})

	var id int64
	err := r.Pool().QueryRow(ctx, `
		INSERT INTO discovery.items (media_url, source_id, page_id, title)
		VALUES ($1,'a',$2,'A talk') RETURNING id`,
		"https://a.example/talk.mp3", page).Scan(&id)
	if err != nil {
		t.Fatalf("seed item: %v", err)
	}
	return id
}

func itemTexts(t *testing.T, r *store.Repo, itemID int64) map[string]string {
	t.Helper()
	rows, err := r.Pool().Query(context.Background(),
		`SELECT lang, text FROM discovery.item_texts WHERE item_id = $1`, itemID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var lang, text string
		if err := rows.Scan(&lang, &text); err != nil {
			t.Fatal(err)
		}
		out[lang] = text
	}
	return out
}

func ptr(s string) *string { return &s }
