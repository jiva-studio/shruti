package store_test

import (
	"encoding/json"
	"os"
	"strconv"
	"strings"
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
// Without SHRUTI_DISCOVERY_TEST_DATABASE_URL they skip. CI always sets it.
func testRepo(t *testing.T) (*store.Repo, *pgxpool.Pool) {
	t.Helper()
	dsn := os.Getenv("SHRUTI_DISCOVERY_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("SHRUTI_DISCOVERY_TEST_DATABASE_URL not set")
	}
	ctx := t.Context()
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
	if err := r.SaveSource(t.Context(), s); err != nil {
		t.Fatalf("save source %s: %v", s.ID, err)
	}
}

func mustPage(t *testing.T, r *store.Repo, p *store.Page) int64 {
	t.Helper()
	id, err := r.SavePage(t.Context(), p)
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
	ctx, now := t.Context(), time.Now().UTC()
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
	ctx, now := t.Context(), time.Now().UTC()
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
	ctx, now := t.Context(), time.Now().UTC()
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
	ctx, now := t.Context(), time.Now().UTC()
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
	ctx, now := t.Context(), time.Now().UTC()
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

// Many sources on one host must not take the whole claim either. Politeness is
// measured per host — one limiter, one breaker, shared by every source on it —
// so twenty-four channels of one site are twenty-four sources and one gap
// between requests. Handed a place each, they fill the claim and then queue
// behind that gap, while an archive on its own host waits for a worker.
func TestOneHostDoesNotTakeTheWholeClaim(t *testing.T) {
	r, _ := testRepo(t)
	ctx, now := t.Context(), time.Now().UTC()

	// Eight sources on one host, one on another.
	for i := range 8 {
		id := "ch" + strconv.Itoa(i)
		mustSource(t, r, &store.Source{ID: id, SeedURLs: []string{"https://one.example/" + id}, Enabled: true})
		p := mustPage(t, r, &store.Page{URL: "https://one.example/" + id + "/list", SourceID: ptr(id), NextCheckAt: &now})
		var links []string
		for j := range 30 {
			links = append(links, "https://one.example/"+id+"/talk/"+strconv.Itoa(j))
		}
		if err := r.ReplacePageLinks(ctx, p, links); err != nil {
			t.Fatal(err)
		}
	}
	mustSource(t, r, &store.Source{ID: "alone", SeedURLs: []string{"https://other.example/"}, Enabled: true})
	p := mustPage(t, r, &store.Page{URL: "https://other.example/list", SourceID: ptr("alone"), NextCheckAt: &now})
	var links []string
	for j := range 30 {
		links = append(links, "https://other.example/talk/"+strconv.Itoa(j))
	}
	if err := r.ReplacePageLinks(ctx, p, links); err != nil {
		t.Fatal(err)
	}

	got, err := r.ClaimWork(ctx, now, 40)
	if err != nil {
		t.Fatal(err)
	}
	var crowded, alone int
	for _, w := range got {
		if w.SourceID == "alone" {
			alone++
		} else {
			crowded++
		}
	}
	if alone < 15 {
		t.Errorf("claim split %d crowded / %d alone; the single-host archive was crowded out", crowded, alone)
	}

	// And within the crowded host the sources still take turns, or one channel
	// of twenty-four would have the host's whole share.
	bySource := map[string]int{}
	for _, w := range got {
		if w.SourceID != "alone" {
			bySource[w.SourceID]++
		}
	}
	if len(bySource) < 4 {
		t.Errorf("only %d of the eight sources on that host appeared: %v", len(bySource), bySource)
	}
}

// One source in full backfill must not take the whole claim.
//
// This is the defect as it happened: an archive being walked for the first time
// produced new pages continuously, so its links always carried the highest page
// id and always sorted first. A second source added later had its links sink
// behind an ever-growing pile — a claim of 200 came back 200 to nil, and it was
// never going to start.
func TestOneBusySourceDoesNotTakeTheWholeClaim(t *testing.T) {
	r, _ := testRepo(t)
	ctx, now := t.Context(), time.Now().UTC()
	mustSource(t, r, &store.Source{ID: "busy", SeedURLs: []string{"https://busy.example/"}, Enabled: true})
	mustSource(t, r, &store.Source{ID: "quiet", SeedURLs: []string{"https://quiet.example/"}, Enabled: true})

	// The quiet source found its links early and then stopped producing pages.
	quiet := mustPage(t, r, &store.Page{URL: "https://quiet.example/list", SourceID: ptr("quiet"), NextCheckAt: &now})
	var quietLinks []string
	for i := range 40 {
		quietLinks = append(quietLinks, "https://quiet.example/talk/"+strconv.Itoa(i))
	}
	if err := r.ReplacePageLinks(ctx, quiet, quietLinks); err != nil {
		t.Fatal(err)
	}

	// The busy one keeps producing pages, so its links keep arriving with a
	// higher page id than anything the quiet source will ever have again.
	for p := range 20 {
		id := mustPage(t, r, &store.Page{
			URL: "https://busy.example/list/" + strconv.Itoa(p), SourceID: ptr("busy"), NextCheckAt: &now,
		})
		var links []string
		for i := range 20 {
			links = append(links, "https://busy.example/talk/"+strconv.Itoa(p)+"-"+strconv.Itoa(i))
		}
		if err := r.ReplacePageLinks(ctx, id, links); err != nil {
			t.Fatal(err)
		}
	}

	got, err := r.ClaimWork(ctx, now, 100)
	if err != nil {
		t.Fatal(err)
	}
	by := map[string]int{}
	for _, w := range got {
		by[w.SourceID]++
	}
	if by["quiet"] == 0 {
		t.Fatalf("the quiet source got nothing: %v", by)
	}
	// Round robin over two sources with plenty each: near enough half.
	if by["quiet"] < 40 || by["busy"] < 40 {
		t.Errorf("claim split %v; want the two sources taking turns", by)
	}
}

// A turn nobody takes is not wasted. A source with a handful of addresses
// contributes them and the rest of the claim goes to whoever else has work.
func TestASourceWithLittleWorkDoesNotHoldTheClaimOpen(t *testing.T) {
	r, _ := testRepo(t)
	ctx, now := t.Context(), time.Now().UTC()
	mustSource(t, r, &store.Source{ID: "big", SeedURLs: []string{"https://big.example/"}, Enabled: true})
	mustSource(t, r, &store.Source{ID: "small", SeedURLs: []string{"https://small.example/"}, Enabled: true})

	big := mustPage(t, r, &store.Page{URL: "https://big.example/list", SourceID: ptr("big"), NextCheckAt: &now})
	var many []string
	for i := range 60 {
		many = append(many, "https://big.example/talk/"+strconv.Itoa(i))
	}
	if err := r.ReplacePageLinks(ctx, big, many); err != nil {
		t.Fatal(err)
	}
	small := mustPage(t, r, &store.Page{URL: "https://small.example/list", SourceID: ptr("small"), NextCheckAt: &now})
	if err := r.ReplacePageLinks(ctx, small, []string{"https://small.example/talk/1"}); err != nil {
		t.Fatal(err)
	}

	got, err := r.ClaimWork(ctx, now, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 50 {
		t.Fatalf("claimed %d of 50; turns nobody could take were left empty", len(got))
	}
}

// A disabled source is not touched. Manual runs are a different matter and use
// DuePages, which deliberately does not filter this way.
func TestDisabledSourceIsNotClaimed(t *testing.T) {
	r, _ := testRepo(t)
	ctx, now := t.Context(), time.Now().UTC()
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
	ctx, now := t.Context(), time.Now().UTC()
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
	ctx := t.Context()
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
	ctx := t.Context()
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
	ctx := t.Context()
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
	ctx := t.Context()

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
	ctx := t.Context()

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
	ctx, now := t.Context(), time.Now().UTC()
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
	ctx := t.Context()
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
	rows, err := r.Pool().Query(t.Context(),
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

// Two spellings of one person are proposed, never joined. A rule loose enough
// to catch every spelling of one speaker is loose enough to join two speakers,
// and afterwards the result does not say which rows were wrong.
func TestAlikeProposesAcrossAlphabets(t *testing.T) {
	r, _ := testRepo(t)
	ctx := t.Context()

	ru, err := r.ResolveAuthor(ctx, "Локанатха Свами")
	if err != nil || ru == 0 {
		t.Fatalf("= %d, %v", ru, err)
	}
	en, err := r.ResolveAuthor(ctx, "Lokanatha Swami")
	if err != nil || en == 0 {
		t.Fatalf("= %d, %v", en, err)
	}
	if ru == en {
		t.Fatal("the two alphabets resolved to one person on their own; nothing left to propose")
	}

	groups, err := r.Alike(ctx, 50)
	if err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, g := range groups {
		var sawRU, sawEN bool
		for _, a := range g.Authors {
			sawRU = sawRU || a.ID == ru
			sawEN = sawEN || a.ID == en
		}
		found = found || (sawRU && sawEN)
	}
	if !found {
		t.Errorf("the two spellings were not proposed as one person: %+v", groups)
	}
}

// Merging moves the spellings, not the recordings. That is what keeps the next
// crawl from resolving the absorbed name back to a row it just recreated.
func TestMergingMovesTheSpellings(t *testing.T) {
	r, _ := testRepo(t)
	ctx := t.Context()
	mustSource(t, r, &store.Source{ID: "a", SeedURLs: []string{"https://a.example/"}, Enabled: true})
	page := mustPage(t, r, &store.Page{URL: "https://a.example/p", SourceID: ptr("a")})

	keep, _ := r.ResolveAuthor(ctx, "Локанатха Свами")
	absorb, _ := r.ResolveAuthor(ctx, "Lokanatha Swami")

	item := &store.Item{MediaURL: "https://a.example/1.mp3", PageID: &page, SourceID: ptr("a"), Author: "Lokanatha Swami"}
	if _, err := r.SaveItem(ctx, item); err != nil {
		t.Fatal(err)
	}
	if err := r.SetItemAuthors(ctx, item.ID, []int64{absorb}); err != nil {
		t.Fatal(err)
	}

	if err := r.MergeAuthors(ctx, keep, absorb); err != nil {
		t.Fatal(err)
	}

	again, err := r.ResolveAuthor(ctx, "Lokanatha Swami")
	if err != nil {
		t.Fatal(err)
	}
	if again != keep {
		t.Errorf("the absorbed spelling resolves to %d, want %d — the next crawl would undo the merge", again, keep)
	}
	authors, err := r.Authors(ctx, "", 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(authors) != 1 || authors[0].ID != keep || authors[0].Items != 1 {
		t.Errorf("after merging: %+v", authors)
	}
}

// A recording linked to both would break the primary key, so one link is
// dropped rather than moved.
func TestMergingARecordingLinkedToBoth(t *testing.T) {
	r, _ := testRepo(t)
	ctx := t.Context()
	mustSource(t, r, &store.Source{ID: "a", SeedURLs: []string{"https://a.example/"}, Enabled: true})
	page := mustPage(t, r, &store.Page{URL: "https://a.example/p", SourceID: ptr("a")})

	keep, _ := r.ResolveAuthor(ctx, "Локанатха Свами")
	absorb, _ := r.ResolveAuthor(ctx, "Lokanatha Swami")
	item := &store.Item{MediaURL: "https://a.example/1.mp3", PageID: &page, SourceID: ptr("a")}
	if _, err := r.SaveItem(ctx, item); err != nil {
		t.Fatal(err)
	}
	if err := r.SetItemAuthors(ctx, item.ID, []int64{keep, absorb}); err != nil {
		t.Fatal(err)
	}
	if err := r.MergeAuthors(ctx, keep, absorb); err != nil {
		t.Fatalf("merging a recording linked to both: %v", err)
	}
	authors, _ := r.Authors(ctx, "", 20)
	if len(authors) != 1 || authors[0].Items != 1 {
		t.Errorf("= %+v", authors)
	}
}

func TestMergingSomebodyIntoThemselvesIsRefused(t *testing.T) {
	r, _ := testRepo(t)
	id, _ := r.ResolveAuthor(t.Context(), "Локанатха Свами")
	if err := r.MergeAuthors(t.Context(), id, id); err == nil {
		t.Error("merging a person into themselves was allowed")
	}
}

// A fix to how a name is read does not reach what is already stored: a
// recording is linked when its page is read, and a page is only read again when
// the site changed, the prompt changed, or the source's script did. A
// correction in Go changes none of those, so what was written before the fix
// stays wrong for ever.
//
// This is the pass that repairs it, over the database and nothing else.
func TestRelinkAttachesWhatWasAlreadyStored(t *testing.T) {
	r, _ := testRepo(t)
	ctx := t.Context()
	mustSource(t, r, &store.Source{ID: "a", SeedURLs: []string{"https://a.example/"}, Enabled: true})
	page := mustPage(t, r, &store.Page{URL: "https://a.example/p", SourceID: ptr("a")})

	// Written the way the broken code left them: the name is on the row, the
	// key is empty, and nothing is linked.
	for i, name := range []string{"Олег Торсунов", "Олег Торсунов", "Е.М. Сарвагья дас", "Radhanath Swami"} {
		item := &store.Item{
			MediaURL: "https://a.example/" + strconv.Itoa(i) + ".mp3",
			PageID:   &page, SourceID: ptr("a"), Author: name,
		}
		if _, err := r.SaveItem(ctx, item); err != nil {
			t.Fatal(err)
		}
		if _, err := r.Pool().Exec(ctx, `UPDATE discovery.items SET author_key = '' WHERE id = $1`, item.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := r.Pool().Exec(ctx, `DELETE FROM discovery.item_authors WHERE item_id = $1`, item.ID); err != nil {
			t.Fatal(err)
		}
	}

	linked, err := r.RelinkAuthors(ctx, 2)
	if err != nil {
		t.Fatal(err)
	}
	if linked != 4 {
		t.Errorf("linked %d, want 4", linked)
	}

	// Three people, not four: the same speaker written twice is one person.
	authors, err := r.Authors(ctx, "", 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(authors) != 3 {
		t.Fatalf("%d people: %+v", len(authors), authors)
	}
	for _, a := range authors {
		if a.Name == "Олег Торсунов" && a.Items != 2 {
			t.Errorf("Торсунов has %d recordings, want 2", a.Items)
		}
	}

	// And the stored key is repaired too, or every filter that goes through the
	// column rather than the link keeps missing the recording.
	var empty int
	if err := r.Pool().QueryRow(ctx,
		`SELECT count(*) FROM discovery.items WHERE author <> '' AND coalesce(author_key,'') = ''`).Scan(&empty); err != nil {
		t.Fatal(err)
	}
	if empty != 0 {
		t.Errorf("%d recordings still carry an empty key", empty)
	}
}

// Running it twice changes nothing the second time, and a name that is only a
// form of address resolves to nobody without spinning the loop for ever.
func TestRelinkIsSafeToRunAgain(t *testing.T) {
	r, _ := testRepo(t)
	ctx := t.Context()
	mustSource(t, r, &store.Source{ID: "a", SeedURLs: []string{"https://a.example/"}, Enabled: true})
	page := mustPage(t, r, &store.Page{URL: "https://a.example/p", SourceID: ptr("a")})

	// The second is punctuation: it reduces to nothing, so it belongs to
	// nobody. A bare "прабху" would not do — a form of address is only
	// recognised as one when it follows a name, and on its own it is a word
	// like any other.
	for i, name := range []string{"Локанатха Свами", "—"} {
		item := &store.Item{
			MediaURL: "https://a.example/" + strconv.Itoa(i) + ".mp3",
			PageID:   &page, SourceID: ptr("a"), Author: name,
		}
		if _, err := r.SaveItem(ctx, item); err != nil {
			t.Fatal(err)
		}
		if _, err := r.Pool().Exec(ctx, `DELETE FROM discovery.item_authors WHERE item_id = $1`, item.ID); err != nil {
			t.Fatal(err)
		}
	}

	first, err := r.RelinkAuthors(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if first != 1 {
		t.Errorf("linked %d, want 1 — the other is a form of address and belongs to nobody", first)
	}
	second, err := r.RelinkAuthors(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if second != 0 {
		t.Errorf("a second run linked %d more", second)
	}
}

// A recording that is read again without being re-normalized writes back what
// it read, so what it reads has to include who it is by. It did not: Authors
// was never selected, so every re-visit wrote nobody.
//
// It stayed harmless only because a nil slice reaches Postgres as NULL and
// "NOT (author_id = ANY(NULL))" matches no row. Both halves are fixed together,
// because fixing either one alone is what would have done the damage.
func TestAReadRecordingKnowsWhoItIsBy(t *testing.T) {
	r, _ := testRepo(t)
	ctx := t.Context()
	mustSource(t, r, &store.Source{ID: "a", SeedURLs: []string{"https://a.example/"}, Enabled: true})
	page := mustPage(t, r, &store.Page{URL: "https://a.example/p", SourceID: ptr("a")})

	item := &store.Item{
		MediaURL: "https://a.example/1.mp3", PageID: &page, SourceID: ptr("a"),
		Author: "Radhanath Swami", Authors: []string{"Radhanath Swami", "Yamuna Devi Dasi"},
	}
	if _, err := r.SaveItem(ctx, item); err != nil {
		t.Fatal(err)
	}
	var ids []int64
	for _, name := range item.Authors {
		id, err := r.ResolveAuthor(ctx, name)
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	if err := r.SetItemAuthors(ctx, item.ID, ids); err != nil {
		t.Fatal(err)
	}

	read, err := r.ItemByMediaURL(ctx, item.MediaURL)
	if err != nil {
		t.Fatal(err)
	}
	if len(read.Authors) != 2 {
		t.Fatalf("read back %v; a re-visit would write that, unlinking both", read.Authors)
	}
}

// And an empty set really does clear the links, rather than quietly doing
// nothing. The old form was NULL for an empty set, so "this recording is by
// nobody" was unrepresentable — and would have become "delete everything" the
// moment somebody tidied the nil away.
func TestNobodyMeansNobody(t *testing.T) {
	r, _ := testRepo(t)
	ctx := t.Context()
	mustSource(t, r, &store.Source{ID: "a", SeedURLs: []string{"https://a.example/"}, Enabled: true})
	page := mustPage(t, r, &store.Page{URL: "https://a.example/p", SourceID: ptr("a")})

	item := &store.Item{MediaURL: "https://a.example/2.mp3", PageID: &page, SourceID: ptr("a"), Author: "Somebody"}
	if _, err := r.SaveItem(ctx, item); err != nil {
		t.Fatal(err)
	}
	id, err := r.ResolveAuthor(ctx, "Somebody")
	if err != nil {
		t.Fatal(err)
	}
	if err := r.SetItemAuthors(ctx, item.ID, []int64{id}); err != nil {
		t.Fatal(err)
	}
	if err := r.SetItemAuthors(ctx, item.ID, nil); err != nil {
		t.Fatal(err)
	}
	names, err := r.ItemAuthorNames(ctx, item.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 0 {
		t.Errorf("still linked to %v", names)
	}
}

// A stated archive stays stated through an ordinary edit: the kind decides
// whether a model is asked at all.
func TestAnEditDoesNotChangeWhatKindOfArchiveThisIs(t *testing.T) {
	r, _ := testRepo(t)
	ctx := t.Context()

	mustSource(t, r, &store.Source{ID: "a", SeedURLs: []string{"https://a.example/"},
		Kind: store.KindStated})
	mustSource(t, r, &store.Source{ID: "a", SeedURLs: []string{"https://a.example/"}, Enabled: true})

	got, err := r.Source(ctx, "a")
	if err != nil {
		t.Fatal(err)
	}
	if got.Kind != store.KindStated {
		t.Errorf("kind after an edit = %q", got.Kind)
	}
	if !got.Enabled {
		t.Errorf("the edit itself did not take")
	}

	// An archive nobody classified is material: the guess that fails cheaply.
	mustSource(t, r, &store.Source{ID: "b", SeedURLs: []string{"https://b.example/"}})
	fresh, err := r.Source(ctx, "b")
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Kind != store.KindMaterial {
		t.Errorf("an unsaid kind = %q", fresh.Kind)
	}
}

// What the archive printed — a length, a cycle, a still — is read by a script
// and by nothing else, so a pass with no script behind it has no news about it.
// What the model reads is not kept this way: an empty answer is an answer.
func TestAPassWithNothingToSayLeavesThePrintedFactsAlone(t *testing.T) {
	r, _ := testRepo(t)
	ctx := t.Context()

	mustSource(t, r, &store.Source{ID: "s", SeedURLs: []string{"https://s.example/"}})
	sid := "s"
	it := &store.Item{
		MediaURL: "https://s.example/a.mp3", SourceID: &sid,
		Title: "Славная смерть", Author: "Бхакти Вигьяна Госвами",
		DurationS: 4245, CollectionTitle: "Цикл", CoverURL: "https://s.example/a.jpg",
		Raw:    json.RawMessage(`{"filename":"a.mp3","path_segments":["2014"]}`),
		Status: store.StatusNormalized,
	}
	if _, err := r.SaveItem(ctx, it); err != nil {
		t.Fatal(err)
	}
	// The same recording seen again by a pass that had no script to read it.
	if _, err := r.SaveItem(ctx, &store.Item{
		MediaURL: "https://s.example/a.mp3", SourceID: &sid,
		Title: "Славная смерть", Status: store.StatusNormalized,
	}); err != nil {
		t.Fatal(err)
	}

	got, err := r.ItemByMediaURL(ctx, "https://s.example/a.mp3")
	if err != nil {
		t.Fatal(err)
	}
	if got.DurationS != 4245 || got.CollectionTitle != "Цикл" || got.CoverURL == "" {
		t.Errorf("printed facts lost: duration=%d collection=%q cover=%q",
			got.DurationS, got.CollectionTitle, got.CoverURL)
	}
	// The material the model was shown outlives the pass too, or a prompt
	// change can only be answered by asking the archive for the page again.
	if !strings.Contains(string(got.Raw), "a.mp3") {
		t.Errorf("raw = %s", got.Raw)
	}
	// An author the pass did not name is gone, because that is an answer.
	if got.Author != "" {
		t.Errorf("author = %q, want it cleared", got.Author)
	}
}
