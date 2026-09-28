package index_test

import (
	"context"
	"testing"
	"time"

	"github.com/jiva-studio/shruti/discovery/internal/application/index"
	"github.com/jiva-studio/shruti/discovery/internal/application/normalize"
	"github.com/jiva-studio/shruti/discovery/internal/application/script"
	"github.com/jiva-studio/shruti/discovery/internal/domain"
	"github.com/jiva-studio/shruti/discovery/internal/store"
)

// countingEmbedder hands back a vector per text and bills each call once.
type countingEmbedder struct {
	texts []string
	owed  []domain.Spend
}

func (e *countingEmbedder) Embed(_ context.Context, texts []string) ([][]float32, error) {
	e.texts = append(e.texts, texts...)
	out := make([][]float32, len(texts))
	for i := range texts {
		v := make([]float32, 1536)
		v[i%1536] = 1
		out[i] = v
	}
	tokens, cost := int64(7*len(texts)), 0.25
	e.owed = append(e.owed, domain.Spend{Model: "test-embed", Items: len(texts), Tokens: &tokens, CostUSD: &cost})
	return out, nil
}

func (e *countingEmbedder) Model() string { return "test-embed" }

func (e *countingEmbedder) Spent() []domain.Spend {
	out := e.owed
	e.owed = nil
	return out
}

// seriesPage is an audioveda talk that names the cycle it belongs to.
func seriesPage(title string) string {
	return `<html lang="ru"><body>
		<script type="application/ld+json">{"name":"` + title + `","author":{"name":"Леонид Тугутов"},"datePublished":"2023-01-23","isPartOf":{"name":"Брахмачари ашрам"}}</script>
		<div itemprop="transcript"><p>Первая строка лекции.</p><p>Вторая строка лекции.</p></div>
		<a href="/audio/` + title + `.mp3">слушать</a></body></html>`
}

func statedService(t *testing.T, repo *store.Repo, fetcher index.Fetcher, now time.Time) *index.Service {
	t.Helper()
	if err := repo.SaveSource(t.Context(), &domain.Archive{
		ID: "audioveda", SeedURLs: []string{"https://audioveda.ru/"}, Enabled: true,
		Kind: domain.KindStated,
	}); err != nil {
		t.Fatal(err)
	}
	runner, err := script.New()
	if err != nil {
		t.Fatal(err)
	}
	return &index.Service{
		Fetcher: fetcher, Normalizer: normalize.Stub{},
		Store: repo, Scripts: runner, Now: func() time.Time { return now },
	}
}

// Two talks that name the same cycle end up as two parts of one collection,
// in the order they were read.
func TestPartsNamingOneCycleShareIt(t *testing.T) {
	repo := testRepo(t)
	ctx := t.Context()
	fetcher := &pageFetcher{}
	svc := statedService(t, repo, fetcher, time.Date(2026, time.August, 7, 12, 0, 0, 0, time.UTC))

	for i, title := range []string{"one", "two"} {
		fetcher.body = seriesPage(title)
		if _, err := svc.Item(ctx, "https://audioveda.ru/audios/"+title, "audioveda", false); err != nil {
			t.Fatalf("visit %d: %v", i, err)
		}
	}
	// Reading a part again does not file it twice.
	if _, err := svc.Item(ctx, "https://audioveda.ru/audios/two", "audioveda", true); err != nil {
		t.Fatal(err)
	}

	cycles, err := repo.Collections(ctx, "audioveda", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(cycles) != 1 {
		t.Fatalf("%d collections, want one", len(cycles))
	}
	c := cycles[0]
	if c.Title != "Брахмачари ашрам" || c.Author != "Леонид Тугутов" || c.MemberCount != 2 {
		t.Errorf("collection = %+v", c)
	}
	if len(c.Members) != 2 || c.Members[0].Title != "one" || c.Members[1].Title != "two" {
		t.Errorf("members = %+v", c.Members)
	}
}

// What a page yields is embedded once: a second visit finds the vectors in the
// cache and buys nothing. What was bought is written down with its price.
func TestEmbeddingsAreBoughtOnceAndCharged(t *testing.T) {
	repo := testRepo(t)
	ctx := t.Context()
	fetcher := &pageFetcher{body: seriesPage("one")}
	svc := statedService(t, repo, fetcher, time.Date(2026, time.August, 7, 12, 0, 0, 0, time.UTC))
	embedder := &countingEmbedder{}
	svc.Embedder = embedder

	report, err := svc.Item(ctx, "https://audioveda.ru/audios/one", "audioveda", false)
	if err != nil {
		t.Fatal(err)
	}
	if report.ChunksIndexed == 0 {
		t.Fatal("nothing was indexed")
	}
	bought := len(embedder.texts)
	if bought == 0 {
		t.Fatal("nothing was embedded")
	}

	var chunks, withVector int
	if err := repo.Pool().QueryRow(ctx,
		`SELECT count(*), count(embedding) FROM discovery.chunks`).Scan(&chunks, &withVector); err != nil {
		t.Fatal(err)
	}
	if chunks != report.ChunksIndexed || withVector != chunks {
		t.Errorf("chunks = %d with %d vectors, report says %d", chunks, withVector, report.ChunksIndexed)
	}

	var charges int
	var tokens int64
	if err := repo.Pool().QueryRow(ctx,
		`SELECT count(*), coalesce(sum(tokens_in),0) FROM discovery.spend
		 WHERE kind = 'embed' AND model = 'test-embed' AND source_id = 'audioveda'`).Scan(&charges, &tokens); err != nil {
		t.Fatal(err)
	}
	if charges != 1 || tokens != int64(7*bought) {
		t.Errorf("charges = %d for %d tokens, want one for %d", charges, tokens, 7*bought)
	}

	if _, err := svc.Item(ctx, "https://audioveda.ru/audios/one", "audioveda", true); err != nil {
		t.Fatal(err)
	}
	if len(embedder.texts) != bought {
		t.Errorf("the second visit embedded %d texts again; the cache should have answered",
			len(embedder.texts)-bought)
	}
}

// Rechunk cuts the stored prose again without fetching anything, and buys only
// what the cache does not already hold.
func TestRechunkRebuildsChunksFromStoredProse(t *testing.T) {
	repo := testRepo(t)
	ctx := t.Context()
	fetcher := &pageFetcher{body: seriesPage("one")}
	svc := statedService(t, repo, fetcher, time.Date(2026, time.August, 7, 12, 0, 0, 0, time.UTC))
	embedder := &countingEmbedder{}
	svc.Embedder = embedder

	report, err := svc.Item(ctx, "https://audioveda.ru/audios/one", "audioveda", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repo.Pool().Exec(ctx, `DELETE FROM discovery.chunks`); err != nil {
		t.Fatal(err)
	}
	reads, bought := fetcher.reads, len(embedder.texts)

	n, err := svc.Rechunk(ctx, "audioveda", 0)
	if err != nil {
		t.Fatal(err)
	}
	if n != report.ChunksIndexed {
		t.Errorf("rechunk wrote %d chunks, the visit wrote %d", n, report.ChunksIndexed)
	}
	var prose int
	if err := repo.Pool().QueryRow(ctx,
		`SELECT count(*) FROM discovery.chunks WHERE kind = 'page_text'`).Scan(&prose); err != nil {
		t.Fatal(err)
	}
	if prose == 0 {
		t.Error("the stored transcript was not cut again")
	}
	if fetcher.reads != reads {
		t.Error("rechunk fetched the page")
	}
	if len(embedder.texts) != bought {
		t.Error("rechunk bought vectors the cache already held")
	}
}
