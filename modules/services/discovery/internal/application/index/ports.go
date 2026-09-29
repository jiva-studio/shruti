package index

import (
	"context"
	"time"

	"github.com/jiva-studio/shruti/discovery/internal/domain"
)

// Fetcher is the polite HTTP client, narrowed to what indexing needs.
type Fetcher interface {
	Get(ctx context.Context, url string, req domain.FetchRequest) (*domain.FetchResponse, error)
	Allowed(ctx context.Context, url string) bool
}

// Embedder turns text into vectors. Nil leaves items stored but unsearchable
// by meaning, which is a degraded service rather than a broken one.
type Embedder interface {
	Embed(ctx context.Context, texts []string) ([][]float32, error)
	Model() string
	// Spent is what the calls made so far were billed, and forgets them.
	Spent() []domain.Spend
}

// Store is everything indexing reads and writes.
type Store interface {
	Archives
	Pages
	Recordings
	Collections
	EmbeddingCache
	Charges
}

// Archives answers what an archive asked for: its credentials, its pace, its
// script and its schedule. A nil archive with no error is one nobody
// configured.
type Archives interface {
	Source(ctx context.Context, id string) (*domain.Archive, error)
}

// Pages is the record of every visit: the validators the next one compares,
// when it happens, and where the page pointed.
//
// A nil page with no error is one never fetched. SavePage keeps the stored
// body and item-set hashes and prompt version when it is handed empty ones;
// MarkPageIndexed is the write that sets them.
type Pages interface {
	PageByURL(ctx context.Context, url string) (*domain.Page, error)
	SavePage(ctx context.Context, p *domain.Page) (int64, error)
	MarkPageIndexed(ctx context.Context, id int64, bodySHA, itemSet, promptVersion, scriptVersion string) error
	ReplacePageLinks(ctx context.Context, pageID int64, urls []string) error
}

// Recordings is what the pages yielded, with who speaks on each, the verses it
// covers, the prose written about it and the chunks it is found by.
//
// ItemByMediaURL answers nil for a file never seen, and otherwise brings the
// recording's references and speakers along. Each Replace swaps a whole set in
// one step, so nothing reads it half written.
type Recordings interface {
	ItemByMediaURL(ctx context.Context, mediaURL string) (*domain.Recording, error)
	ItemsByPage(ctx context.Context, pageID int64) ([]domain.Recording, error)
	ItemsAfter(ctx context.Context, sourceID string, afterID int64, limit int) ([]domain.Recording, error)
	SaveItem(ctx context.Context, it *domain.Recording) (isNew bool, err error)
	MarkMediaVanished(ctx context.Context, itemID int64, at time.Time) error
	ResolveAuthor(ctx context.Context, name string) (int64, error)
	SetItemAuthors(ctx context.Context, itemID int64, authorIDs []int64) error
	ReplaceItemRefs(ctx context.Context, itemID int64, refs []domain.Ref, origin string) error
	ReplaceItemTexts(ctx context.Context, itemID int64, kind string, texts []domain.ItemText) error
	ItemTexts(ctx context.Context, itemID int64, kind string) ([]domain.ItemText, error)
	ReplaceItemChunks(ctx context.Context, itemID int64, chunks []domain.Chunk) error
}

// Collections are the cycles recordings are filed under. CollectionByTitle
// answers nil when the archive has no cycle of that name by that speaker.
type Collections interface {
	ItemHasCollection(ctx context.Context, itemID int64) (bool, error)
	CollectionByTitle(ctx context.Context, sourceID, title, author string) (*domain.Collection, error)
	SaveCollection(ctx context.Context, c *domain.Collection) error
	AddMember(ctx context.Context, collectionID, itemID int64) error
}

// EmbeddingCache holds the vectors already paid for, keyed by model and text.
type EmbeddingCache interface {
	CachedEmbeddings(ctx context.Context, model string, texts []string) (map[string][]float32, error)
	SaveEmbeddings(ctx context.Context, model string, byText map[string][]float32) error
}

// Charges keeps what each model call cost.
type Charges interface {
	RecordSpend(ctx context.Context, c domain.Charge) error
}
