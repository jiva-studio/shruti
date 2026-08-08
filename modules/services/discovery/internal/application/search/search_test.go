package search_test

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti/discovery/internal/application/search"
	"github.com/jiva-studio/shruti/discovery/internal/domain"
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

// A filter carries what a person wrote, and a person writes a name rather than
// a code. "Бхагавад-гита" and "BG" are one book; only one of them is what the
// column holds, and the other used to match nothing.
func TestAScriptureIsAskedForByName(t *testing.T) {
	svc, repo, pool := testSearch(t)
	ctx := context.Background()
	id := add(t, repo, pool, "https://a.example/bg.mp3", "Bhagavad-gita 2.13", "Radhanath Swami", "en")
	if err := repo.ReplaceItemRefs(ctx, id, []domain.Ref{{Source: "BG", Tokens: "2.13"}},
		store.OriginCrawl); err != nil {
		t.Fatal(err)
	}

	for _, name := range []string{"BG", "bg", "Бхагавад-гита", "Бхагавад гита", "Bhagavad-gita", "БГ"} {
		hits, err := svc.Search(ctx, search.Query{Sources: []string{name}, Limit: 10})
		if err != nil {
			t.Fatal(err)
		}
		if len(hits) != 1 {
			t.Errorf("%q found %d, want the one recording that cites it", name, len(hits))
		}
	}

	// A book nobody named is still nothing, rather than everything.
	hits, err := svc.Search(ctx, search.Query{Sources: []string{"Коран"}, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 0 {
		t.Errorf("an unknown book returned %d hits", len(hits))
	}
}

// A name is written in whichever alphabet the archive that published it used,
// and a person asking does not know which. "Vatsala das" has to find "Ватсала
// дас", and "Adi Gadadhara" has to find "Adi Gadadhar".
//
// The fold is a way to look somebody up, never a claim about who they are: it
// drops what a form of address carries, so it can land on two people, and then
// both come back.
func TestANameIsFoundHoweverItWasWritten(t *testing.T) {
	svc, repo, pool := testSearch(t)
	ctx := context.Background()
	link := func(media, name string) {
		t.Helper()
		id := add(t, repo, pool, media, "Лекция", name, "ru")
		who, err := repo.ResolveAuthor(ctx, name)
		if err != nil {
			t.Fatal(err)
		}
		if err := repo.SetItemAuthors(ctx, id, []int64{who}); err != nil {
			t.Fatal(err)
		}
	}
	link("https://a.example/1.mp3", "Ватсала дас")
	link("https://a.example/2.mp3", "Adi Gadadhar")
	// The same man under both alphabets, as the corpus actually holds him.
	link("https://a.example/3.mp3", "Прабхупада")
	link("https://a.example/4.mp3", "Prabhupada")

	for _, c := range []struct{ asked, want string }{
		{"Ватсала дас", "Ватсала дас"},
		{"Vatsala das", "Ватсала дас"},
		{"vatsala", "Ватсала дас"},
		{"Ватсала", "Ватсала дас"},
		{"Adi Gadadhara", "Adi Gadadhar"},
		{"Ади Гададхар", "Adi Gadadhar"},
	} {
		hits, err := svc.Search(ctx, search.Query{Authors: []string{c.asked}, Limit: 10})
		if err != nil {
			t.Fatal(err)
		}
		if len(hits) != 1 || hits[0].Author != c.want {
			t.Errorf("%q found %d hits %v, want the one by %s", c.asked, len(hits), titles(hits), c.want)
		}
	}

	// One person spelled two ways is found whole, not by whichever spelling was
	// looked up first. Asked in order, the exact tier wins and stops — and a
	// Latin row of ten recordings hides a Cyrillic row of fifteen hundred.
	for _, name := range []string{"Prabhupada", "Прабхупада"} {
		hits, err := svc.Search(ctx, search.Query{Authors: []string{name}, Limit: 10})
		if err != nil {
			t.Fatal(err)
		}
		if len(hits) != 2 {
			t.Errorf("%q found %d of the 2 recordings; both spellings are the same man", name, len(hits))
		}
	}

	// And a name nobody has still finds nobody.
	hits, err := svc.Search(ctx, search.Query{Authors: []string{"Иоанн Кронштадтский"}, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 0 {
		t.Errorf("a stranger found %d hits", len(hits))
	}
}

// A question shaped like a sentence used to find nothing at all. The `simple`
// configuration asked for every word exactly as typed — "лекции о карме" wants
// 'лекции' AND 'о' AND 'карме' — and no title carries a preposition or a case
// ending, so the lane returned nothing and the fusion of two opinions had one.
func TestASentenceFindsWhatItIsAbout(t *testing.T) {
	svc, repo, pool := testSearch(t)
	ctx := context.Background()
	add(t, repo, pool, "https://a.example/1.mp3", "Карма и перерождение", "Радханатх Свами", "ru")
	add(t, repo, pool, "https://a.example/2.mp3", "Смирение преданного", "Радханатх Свами", "ru")
	add(t, repo, pool, "https://a.example/3.mp3", "The nature of karma", "Radhanath Swami", "en")

	// The word as a person would write it in a sentence, inflected, with a
	// preposition beside it.
	hits, err := svc.Search(ctx, search.Query{Text: "лекции о карме", Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) == 0 {
		t.Fatal("a sentence about karma found nothing")
	}
	if hits[0].Title != "Карма и перерождение" {
		t.Errorf("first hit is %q", hits[0].Title)
	}

	// English is stemmed as English, in the same corpus.
	if hits, err = svc.Search(ctx, search.Query{Text: "lectures about karma", Limit: 10}); err != nil {
		t.Fatal(err)
	}
	if len(hits) == 0 {
		t.Error("an English sentence found nothing")
	}

	// And a sentence whose words are never all in one place still finds the
	// part that exists, rather than nothing.
	if hits, err = svc.Search(ctx, search.Query{Text: "карма и смирение вместе", Limit: 10}); err != nil {
		t.Fatal(err)
	}
	if len(hits) < 2 {
		t.Errorf("= %d hits; loosening should have found both talks", len(hits))
	}
}
