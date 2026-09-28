package search_test

import (
	"testing"

	"github.com/jiva-studio/shruti/discovery/internal/application/search"
	"github.com/jiva-studio/shruti/discovery/internal/domain"
	"github.com/jiva-studio/shruti/discovery/internal/store"
)

// axis is a vector of the column's width, pointing along one dimension with a
// little of a second, so each recording sits at its own distance from a query.
func axis(main, side int, sideWeight float32) []float32 {
	v := make([]float32, 1536)
	v[main] = 1
	if side >= 0 {
		v[side] = sideWeight
	}
	return v
}

// addEmbedded stores one recording whose title chunk carries a vector.
func addEmbedded(t *testing.T, repo *store.Repo, media, title, lang string, vec []float32) int64 {
	t.Helper()
	ctx := t.Context()
	it := &domain.Recording{MediaURL: media, Title: title, Language: lang}
	if _, err := repo.SaveItem(ctx, it); err != nil {
		t.Fatalf("save item: %v", err)
	}
	if err := repo.ReplaceItemChunks(ctx, it.ID, []domain.Chunk{
		{ItemID: it.ID, Kind: domain.ChunkTitle, Lang: lang, Text: title, Embedding: vec},
	}); err != nil {
		t.Fatalf("chunks: %v", err)
	}
	return it.ID
}

// The vector lane runs whenever the query arrives embedded. Nothing in these
// titles matches the words asked, so every hit and its order come from meaning
// alone: the closest recording first, then the next.
func TestTheVectorLaneRanksByMeaning(t *testing.T) {
	svc, repo, _ := testSearch(t)
	ctx := t.Context()
	near := addEmbedded(t, repo, "https://a.example/near.mp3", "Alpha", "en", axis(0, 1, 0.1))
	mid := addEmbedded(t, repo, "https://a.example/mid.mp3", "Beta", "ru", axis(1, 0, 0.5))
	far := addEmbedded(t, repo, "https://a.example/far.mp3", "Gamma", "en", axis(2, -1, 0))

	query := axis(0, -1, 0)

	// Unfiltered: the approximate index answers.
	hits, err := svc.Search(ctx, search.Query{Text: "zzzz", Vector: query, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 3 {
		t.Fatalf("hits = %v, want all three by meaning", titles(hits))
	}
	if hits[0].ItemID != near || hits[1].ItemID != mid || hits[2].ItemID != far {
		t.Errorf("order = %v, want Alpha, Beta, Gamma", titles(hits))
	}
	if hits[0].Chunk != "Alpha" {
		t.Errorf("chunk = %q, want the title that matched", hits[0].Chunk)
	}
	if hits[0].Score <= hits[1].Score {
		t.Errorf("scores %v then %v: the fused score does not follow the rank", hits[0].Score, hits[1].Score)
	}

	// Filtered: few enough rows survive that an exact scan answers instead.
	en, err := svc.Search(ctx, search.Query{Text: "zzzz", Vector: query, Languages: []string{"en"}, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(en) != 2 || en[0].ItemID != near || en[1].ItemID != far {
		t.Errorf("filtered = %v, want Alpha then Gamma", titles(en))
	}

	// Paging runs over the fused list.
	page, err := svc.Search(ctx, search.Query{Text: "zzzz", Vector: query, Limit: 1, Offset: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(page) != 1 || page[0].ItemID != mid {
		t.Errorf("second page = %v, want Beta", titles(page))
	}
}

// A query naming nobody the corpus knows is an empty answer from the vector
// lane too, not an unfiltered one.
func TestTheVectorLaneKeepsAnUnknownSpeakerEmpty(t *testing.T) {
	svc, repo, _ := testSearch(t)
	addEmbedded(t, repo, "https://a.example/near.mp3", "Alpha", "en", axis(0, -1, 0))

	hits, err := svc.Search(t.Context(), search.Query{
		Text: "zzzz", Vector: axis(0, -1, 0), Authors: []string{"Nobody Anyone Knows"}, Limit: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 0 {
		t.Errorf("hits = %v, want none", titles(hits))
	}
}
