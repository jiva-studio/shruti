package search_test

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/lectorium/discovery/internal/application/search"
	"github.com/jiva-studio/lectorium/discovery/internal/domain"
	"github.com/jiva-studio/lectorium/discovery/internal/store"
)

// Search builds its SQL by hand, in two lanes, with a filter clause shared
// between them. That is the shape most likely to go wrong quietly: a filter
// that stops narrowing still returns results, and a lane that breaks is hidden
// by the other one.
//
// These run without an embedder on purpose. The lexical lane is the half that
// works with no key and no vectors, and it is also the half a wrong WHERE
// clause shows up in first.
//
// Without LECTORIUM_DISCOVERY_TEST_DATABASE_URL they skip. CI always sets it.
func testSearch(t *testing.T) (*search.Service, *store.Repo, *pgxpool.Pool) {
	t.Helper()
	dsn := os.Getenv("LECTORIUM_DISCOVERY_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("LECTORIUM_DISCOVERY_TEST_DATABASE_URL not set")
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
	return &search.Service{Pool: pool}, store.NewRepo(pool), pool
}

// add stores one recording and the chunks that make it findable.
func add(t *testing.T, repo *store.Repo, pool *pgxpool.Pool, media, title, author, lang string) int64 {
	t.Helper()
	ctx := context.Background()
	it := &store.Item{MediaURL: media, Title: title, Author: author, Language: lang}
	if _, err := repo.SaveItem(ctx, it); err != nil {
		t.Fatalf("save item: %v", err)
	}
	err := repo.ReplaceItemChunks(ctx, it.ID, []store.Chunk{
		{ItemID: it.ID, Kind: store.ChunkTitle, Lang: lang, Text: title},
	})
	if err != nil {
		t.Fatalf("chunks: %v", err)
	}
	return it.ID
}

func titles(hits []search.Hit) []string {
	out := make([]string, 0, len(hits))
	for _, h := range hits {
		out = append(out, h.Title)
	}
	return out
}

func TestLexicalLaneFindsWhatWasTyped(t *testing.T) {
	svc, repo, pool := testSearch(t)
	add(t, repo, pool, "https://a.example/1.mp3", "Surrender and the humble heart", "Radhanath Swami", "en")
	add(t, repo, pool, "https://a.example/2.mp3", "Cooking for Krishna", "Radhanath Swami", "en")

	hits, err := svc.Search(context.Background(), search.Query{Text: "surrender", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 || hits[0].Title != "Surrender and the humble heart" {
		t.Errorf("hits = %v", titles(hits))
	}
}

// A filter that stops narrowing still returns results, which is why it is worth
// a test of its own rather than being taken on trust.
func TestFiltersNarrow(t *testing.T) {
	svc, repo, pool := testSearch(t)
	add(t, repo, pool, "https://a.example/en.mp3", "The holy name", "Radhanath Swami", "en")
	add(t, repo, pool, "https://a.example/ru.mp3", "The holy name", "Bhakti Caitanya Swami", "ru")
	ctx := context.Background()

	all, err := svc.Search(ctx, search.Query{Text: "holy name", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 {
		t.Fatalf("unfiltered = %v, want both", titles(all))
	}

	byLang, err := svc.Search(ctx, search.Query{Text: "holy name", Languages: []string{"ru"}, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(byLang) != 1 {
		t.Errorf("language filter left %d hits, want 1", len(byLang))
	}
}

// Nothing matching is an empty answer, not an error and not everything. A
// filter that silently drops out on an unknown value would return the whole
// corpus, which reads as a working search.
func TestNoMatchIsEmpty(t *testing.T) {
	svc, repo, pool := testSearch(t)
	add(t, repo, pool, "https://a.example/1.mp3", "The holy name", "Radhanath Swami", "en")

	for _, q := range []search.Query{
		{Text: "nothing here matches this", Limit: 10},
		{Text: "holy name", Languages: []string{"xx"}, Limit: 10},
		{Text: "holy name", Sources: []string{"NOSUCHBOOK"}, Limit: 10},
	} {
		hits, err := svc.Search(context.Background(), q)
		if err != nil {
			t.Fatalf("%+v: %v", q, err)
		}
		if len(hits) != 0 {
			t.Errorf("%+v returned %v, want nothing", q, titles(hits))
		}
	}
}

// A search with no embedder configured still answers. Embeddings are a
// degraded-service concern, not a broken one, and this is the lane that proves
// it.
func TestSearchWorksWithoutAnEmbedder(t *testing.T) {
	svc, repo, pool := testSearch(t)
	add(t, repo, pool, "https://a.example/1.mp3", "Bhagavad Gita chapter two", "Radhanath Swami", "en")

	hits, err := svc.Search(context.Background(), search.Query{Text: "bhagavad gita", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) == 0 {
		t.Error("no hits without an embedder; the lexical lane should stand on its own")
	}
}

// A verse is a book AND a coordinate, on the same reference. Asked as two
// conditions they are satisfied by two different references on one recording,
// so a talk on ISO 4 that mentions the Bhagavatam once answered to "SB 4" — of
// which the corpus held none. The more verses a recording covers the more
// coordinates it wrongly answers to, and one of ours covers a thousand.
func TestAVerseIsOneReferenceNotTwoConditions(t *testing.T) {
	svc, repo, pool := testSearch(t)
	ctx := context.Background()

	mixed := add(t, repo, pool, "https://a.example/mixed.mp3", "Sri Isopanisad mantra four", "Sacinandana Swami", "en")
	if err := repo.ReplaceItemRefs(ctx, mixed, []domain.Ref{
		{Source: "ISO", Tokens: "4"},
		{Source: "SB", Tokens: "1.2.10"},
	}, store.OriginCrawl); err != nil {
		t.Fatal(err)
	}
	real := add(t, repo, pool, "https://a.example/sb.mp3", "Fourth canto", "Radhanath Swami", "en")
	if err := repo.ReplaceItemRefs(ctx, real, []domain.Ref{{Source: "SB", Tokens: "4"}},
		store.OriginCrawl); err != nil {
		t.Fatal(err)
	}

	hits, err := svc.Search(ctx, search.Query{Sources: []string{"SB"}, Tokens: "4", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 || hits[0].ItemID != real {
		t.Errorf("SB 4 returned %v; the recording citing ISO 4 and SB 1.2.10 is not a match", titles(hits))
	}

	// Asking for the book alone still finds everything in it.
	book, err := svc.Search(ctx, search.Query{Sources: []string{"SB"}, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(book) != 2 {
		t.Errorf("SB alone returned %d, want both recordings that cite it", len(book))
	}
}

// Several speakers ticked is several speakers, not the first one. Taking the
// first silently answers a question nobody asked, and nothing in the response
// says the rest were dropped.
func TestSeveralSpeakersAreSeveral(t *testing.T) {
	svc, repo, pool := testSearch(t)
	ctx := context.Background()
	// Speakers are rows a recording points at, and the indexer links them in a
	// second step. A fixture that only writes the name on the item is a corpus
	// with nobody in it.
	link := func(media, name string) {
		t.Helper()
		id := add(t, repo, pool, media, "The holy name", name, "en")
		who, err := repo.ResolveAuthor(ctx, name)
		if err != nil {
			t.Fatal(err)
		}
		if err := repo.SetItemAuthors(ctx, id, []int64{who}); err != nil {
			t.Fatal(err)
		}
	}
	link("https://a.example/1.mp3", "Radhanath Swami")
	link("https://a.example/2.mp3", "Bhakti Caitanya Swami")
	link("https://a.example/3.mp3", "Sacinandana Swami")

	both, err := svc.Search(ctx, search.Query{
		Authors: []string{"Radhanath Swami", "Bhakti Caitanya Swami"}, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(both) != 2 {
		t.Errorf("two speakers returned %d hits: %v", len(both), titles(both))
	}

	// A name matching nobody, beside one that does, narrows to the one.
	mixed, err := svc.Search(ctx, search.Query{
		Authors: []string{"Radhanath Swami", "Nobody At All"}, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(mixed) != 1 {
		t.Errorf("= %d hits, want the one speaker who exists", len(mixed))
	}

	// And every name matching nobody is an empty answer, not an unfiltered one.
	none, err := svc.Search(ctx, search.Query{
		Authors: []string{"Nobody At All", "Nor This One"}, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(none) != 0 {
		t.Errorf("= %d hits, want none", len(none))
	}
}
