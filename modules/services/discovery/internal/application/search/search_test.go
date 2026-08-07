package search_test

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti/discovery/internal/application/search"
	"github.com/jiva-studio/shruti/discovery/internal/store"
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
// Without SHRUTI_DISCOVERY_TEST_DATABASE_URL they skip. CI always sets it.
func testSearch(t *testing.T) (*search.Service, *store.Repo, *pgxpool.Pool) {
	t.Helper()
	dsn := os.Getenv("SHRUTI_DISCOVERY_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("SHRUTI_DISCOVERY_TEST_DATABASE_URL not set")
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

	byLang, err := svc.Search(ctx, search.Query{Text: "holy name", Language: "ru", Limit: 10})
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
		{Text: "holy name", Language: "xx", Limit: 10},
		{Text: "holy name", Source: "nosuchsource", Limit: 10},
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
