package index

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

	"github.com/jiva-studio/shruti/discovery/internal/application/script"
	"github.com/jiva-studio/shruti/discovery/internal/domain"
)

// chunkWork is one recording waiting to be embedded, held back so that a whole
// page goes to the embedder at once.
type chunkWork struct {
	item      *domain.Recording
	extracted domain.Item
	// texts is prose the archive published, already Markdown, one per language.
	texts []script.Text
}

// indexChunks embeds what is searchable about a page's recordings, in one
// request for the whole page and skipping whatever has been embedded before.
//
// Only the title. The speaker, the date and the references are exact filters
// living in columns, and folding them into the vector only blurs what it is
// about; the text around a link on a file listing is the site's menu and the
// names of the neighbouring files.
//
// One request per page rather than per file: forty nine round trips of a few
// seconds each would make a page needing one model call take three minutes.
func (s *Service) indexChunks(ctx context.Context, work []chunkWork, sourceID string) (int, error) {
	if s.Embedder == nil || len(work) == 0 {
		return 0, nil
	}

	// Everything this page wants embedded, in order, with the repeats taken out:
	// one listing can carry twenty nine "Hare Krishna Kirtan".
	plan := make([][]domain.Chunk, len(work))
	var wanted []string
	seen := map[string]bool{}
	want := func(text string) {
		if text == "" || seen[text] {
			return
		}
		seen[text] = true
		wanted = append(wanted, text)
	}
	for i, w := range work {
		if title := strings.TrimSpace(w.item.Title); title != "" {
			plan[i] = append(plan[i], domain.Chunk{
				ItemID: w.item.ID, Kind: domain.ChunkTitle,
				Lang: w.item.Language, Text: title,
			})
			want(title)
		}
		// Each language is cut up separately and its pieces carry its name, so a
		// hit can say which transcript it came from. The ordinal restarts per
		// language: it places a piece within its own text, and running it on
		// across two languages would say a Russian passage follows an English
		// one, which is not a thing that happened.
		for _, text := range w.texts {
			for n, part := range Chunks(text.Text) {
				plan[i] = append(plan[i], domain.Chunk{
					ItemID: w.item.ID, Kind: domain.ChunkPageText,
					Lang: text.Lang, Ordinal: n, Text: part,
				})
				want(part)
			}
		}
	}
	if len(wanted) == 0 {
		return 0, nil
	}

	model := s.Embedder.Model()
	vectors, err := s.Store.CachedEmbeddings(ctx, model, wanted)
	if err != nil {
		return 0, err
	}
	if vectors == nil {
		vectors = map[string][]float32{}
	}

	var missing []string
	for _, text := range wanted {
		if _, ok := vectors[text]; !ok {
			missing = append(missing, text)
		}
	}
	if len(missing) > 0 {
		got, err := s.Embedder.Embed(ctx, missing)
		if err != nil {
			return 0, err
		}
		if len(got) != len(missing) {
			return 0, fmt.Errorf("embedder returned %d vectors for %d texts", len(got), len(missing))
		}
		fresh := make(map[string][]float32, len(missing))
		for i, text := range missing {
			vectors[text] = got[i]
			fresh[text] = got[i]
		}
		if err := s.Store.SaveEmbeddings(ctx, model, fresh); err != nil {
			return 0, err
		}
		// Embedding is the larger half of what this service spends — roughly
		// five dollars against the normalizer's one, over the corpus as it
		// stands — so it is counted. The provider reports tokens and a price on
		// every answer.
		s.Metrics.Embedded(len(missing))
		for _, sp := range s.Embedder.Spent() {
			if err := s.Store.RecordSpend(ctx, domain.Charge{
				SourceID: sourceID, Kind: "embed", Model: sp.Model, Items: sp.Items,
				TokensIn: sp.Tokens, CostUSD: sp.CostUSD,
			}); err != nil {
				slog.WarnContext(ctx, "embed_spend_not_recorded", "source", sourceID, "err", err.Error())
			}
			if sp.CostUSD != nil {
				s.Metrics.Spend(*sp.CostUSD)
			}
		}
	}

	total := 0
	for i, w := range work {
		for n := range plan[i] {
			plan[i][n].Embedding = vectors[plan[i][n].Text]
		}
		// A recording the archive never named and wrote nothing about keeps no
		// chunks at all. It is still found by its speaker, its date and the
		// verses it covers.
		if err := s.Store.ReplaceItemChunks(ctx, w.item.ID, plan[i]); err != nil {
			return total, err
		}
		total += len(plan[i])
	}
	return total, nil
}

// Rechunk cuts the prose already stored into chunks again and embeds what is
// new, without fetching anything or calling a model.
//
// It is what makes changing the cut a local decision: the text is in the
// database, and the embedding cache is keyed by the text, so only pieces that
// actually changed are bought.
func (s *Service) Rechunk(ctx context.Context, sourceID string, batch int) (int, error) {
	if batch <= 0 {
		batch = 200
	}
	var after int64
	var total int
	for {
		items, err := s.Store.ItemsAfter(ctx, sourceID, after, batch)
		if err != nil {
			return total, err
		}
		if len(items) == 0 {
			return total, nil
		}
		work := make([]chunkWork, 0, len(items))
		for i := range items {
			item := &items[i]
			after = item.ID
			texts, err := s.Store.ItemTexts(ctx, item.ID, domain.ChunkPageText)
			if err != nil {
				return total, err
			}
			said := make([]script.Text, 0, len(texts))
			for _, t := range texts {
				said = append(said, script.Text{Lang: t.Lang, Text: t.Text})
			}
			work = append(work, chunkWork{item: item, texts: said})
		}
		n, err := s.indexChunks(ctx, work, sourceID)
		if err != nil {
			return total, err
		}
		total += n
	}
}
