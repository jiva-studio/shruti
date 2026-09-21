package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/jiva-studio/lectorium/discovery/internal/domain"
	"github.com/jiva-studio/lectorium/discovery/internal/pgvector"
)

// Item statuses: found, and read.
const (
	StatusDiscovered = "discovered"
	StatusNormalized = "normalized"
)

// What the last visit saw of a recording's file.
const (
	// MediaPresent — the address was on the page.
	MediaPresent = "present"
	// MediaVanished — it was there before and was not this time. Which of "the
	// archive removed it" and "our session expired" that means is not knowable
	// at the moment it happens; MediaMissingSince tells you later.
	MediaVanished = "vanished"
)

// Item is one media file as stored.
type Item struct {
	ID       int64
	MediaURL string
	SourceID *string
	PageID   *int64

	// Raw is everything extraction found, which is what the normalizer is shown.
	// Kept so a recording can be read again with a new prompt out of our own
	// rows rather than by fetching its page again.
	Raw json.RawMessage

	Title  string
	Author string
	// Authors is everyone who spoke; Author is the one written on the recording.
	Authors    []string
	Location   string
	RecordedOn *time.Time
	Language   string
	DurationS  int
	// CoverURL is the picture the archive publishes for this recording, as the
	// script that read the page said it.
	CoverURL        string
	References      []domain.Ref
	CollectionTitle string

	MediaState        string
	MediaSeenAt       *time.Time
	MediaMissingSince *time.Time

	NormInputSHA256   string
	NormPromptVersion string
	NormModel         string

	Status      string
	FirstSeenAt time.Time
	LastSeenAt  time.Time
}

const itemCols = `id, media_url, source_id, page_id, raw,
	coalesce(title,''), coalesce(author,''), coalesce(location,''), recorded_on,
	coalesce(language,''), coalesce(duration_s,0), coalesce(collection_title,''),
	coalesce(cover_url,''),
	media_state, media_seen_at, media_missing_since,
	coalesce(norm_input_sha256,''), coalesce(norm_prompt_version,''), coalesce(norm_model,''),
	status, first_seen_at, last_seen_at`

func scanItem(row pgx.Row) (*Item, error) {
	var it Item
	err := row.Scan(&it.ID, &it.MediaURL, &it.SourceID, &it.PageID, &it.Raw,
		&it.Title, &it.Author, &it.Location, &it.RecordedOn,
		&it.Language, &it.DurationS, &it.CollectionTitle, &it.CoverURL,
		&it.MediaState, &it.MediaSeenAt, &it.MediaMissingSince,
		&it.NormInputSHA256, &it.NormPromptVersion, &it.NormModel,
		&it.Status, &it.FirstSeenAt, &it.LastSeenAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &it, nil
}

// ItemByMediaURL returns the stored item, or nil when this file is new to us.
// References come along, because a re-run that skips normalization has to be
// able to write back what it already knew.
func (r *Repo) ItemByMediaURL(ctx context.Context, mediaURL string) (*Item, error) {
	it, err := scanItem(r.pool.QueryRow(ctx, `SELECT `+itemCols+` FROM discovery.items WHERE media_url = $1`, mediaURL))
	if err != nil || it == nil {
		return it, err
	}
	if it.References, err = r.ItemRefs(ctx, it.ID); err != nil {
		return nil, err
	}
	// Authors come along for the same reason references do, and for a sharper
	// one: a re-visit that skips normalization writes back what it read, and
	// what it read was nobody. It survived only because a nil slice reaches
	// Postgres as NULL and "NOT (author_id = ANY(NULL))" matches no row — a
	// tidy-up of either half would have unlinked every recording from every
	// speaker on the next crawl.
	if it.Authors, err = r.ItemAuthorNames(ctx, it.ID); err != nil {
		return nil, err
	}
	return it, nil
}

// ItemAuthorNames is who a recording is linked to, as they are written.
func (r *Repo) ItemAuthorNames(ctx context.Context, itemID int64) ([]string, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT a.name FROM discovery.item_authors ia
		JOIN discovery.authors a ON a.id = ia.author_id
		WHERE ia.item_id = $1 ORDER BY a.name`, itemID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

// ItemsByPage returns everything we know that was found on one page.
func (r *Repo) ItemsByPage(ctx context.Context, pageID int64) ([]Item, error) {
	rows, err := r.pool.Query(ctx, `SELECT `+itemCols+` FROM discovery.items WHERE page_id = $1 ORDER BY id`, pageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Item
	for rows.Next() {
		it, err := scanItem(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *it)
	}
	return out, rows.Err()
}

// SaveItem writes the item and reports whether it is one we had never seen.
// media_url is the natural key: the same lecture on two archives stays two
// rows, because provenance has to survive.
func (r *Repo) SaveItem(ctx context.Context, it *Item) (isNew bool, err error) {
	if it.Status == "" {
		it.Status = StatusDiscovered
	}
	if it.MediaState == "" {
		it.MediaState = MediaPresent
	}
	if len(it.Raw) == 0 {
		it.Raw = json.RawMessage(`{}`)
	}
	err = r.pool.QueryRow(ctx, `
		INSERT INTO discovery.items
			(media_url, source_id, page_id, raw, title, author, location, recorded_on,
			 language, duration_s, collection_title, author_key, cover_url,
			 media_state, media_seen_at, media_missing_since,
			 norm_input_sha256, norm_prompt_version, norm_model, status)
		VALUES ($1,$2,$3,$19,nullif($4,''),nullif($5,''),nullif($6,''),$7,
			 nullif($8,''),nullif($9,0),nullif($10,''),nullif($17,''),nullif($18,''),
			 $11,$12,NULL,
			 nullif($13,''),nullif($14,''),nullif($15,''),$16)
		ON CONFLICT (media_url) DO UPDATE SET
			source_id           = coalesce(EXCLUDED.source_id, discovery.items.source_id),
			page_id             = coalesce(EXCLUDED.page_id, discovery.items.page_id),
			raw                 = CASE WHEN EXCLUDED.raw = '{}'::jsonb
				THEN discovery.items.raw ELSE EXCLUDED.raw END,
			title               = EXCLUDED.title,
			author              = EXCLUDED.author,
			location            = EXCLUDED.location,
			recorded_on         = EXCLUDED.recorded_on,
			language            = EXCLUDED.language,
			author_key          = EXCLUDED.author_key,
			-- The three below are what the archive printed, and only a script
			-- reads them, so a pass with no script behind it has no news about
			-- them. The fields above are read by the model, where an empty
			-- answer is an answer.
			duration_s          = coalesce(EXCLUDED.duration_s, discovery.items.duration_s),
			collection_title    = coalesce(EXCLUDED.collection_title, discovery.items.collection_title),
			cover_url           = coalesce(EXCLUDED.cover_url, discovery.items.cover_url),
			-- Seeing the file again clears the fact that it was ever missing.
			media_state         = EXCLUDED.media_state,
			media_seen_at       = EXCLUDED.media_seen_at,
			media_missing_since = NULL,
			norm_input_sha256   = EXCLUDED.norm_input_sha256,
			norm_prompt_version = EXCLUDED.norm_prompt_version,
			norm_model          = EXCLUDED.norm_model,
			status              = EXCLUDED.status,
			last_seen_at        = now()
		RETURNING id, (xmax = 0)`,
		it.MediaURL, it.SourceID, it.PageID, it.Title, it.Author, it.Location, it.RecordedOn,
		it.Language, it.DurationS, it.CollectionTitle,
		it.MediaState, it.MediaSeenAt,
		it.NormInputSHA256, it.NormPromptVersion, it.NormModel, it.Status,
		domain.Key(it.Author), it.CoverURL, it.Raw,
	).Scan(&it.ID, &isNew)
	return isNew, err
}

// TouchItem records that a file is still there without rewriting anything we
// already know about it.
func (r *Repo) TouchItem(ctx context.Context, id int64) error {
	_, err := r.pool.Exec(ctx, `UPDATE discovery.items SET last_seen_at = now() WHERE id = $1`, id)
	return err
}

// What a chunk is. See migration 0004.
const (
	// ChunkTitle is the recording's own name.
	ChunkTitle = "title"
	// ChunkPageText is prose the archive published about it — a search key,
	// never a transcript.
	ChunkPageText = "page_text"
)

// Chunk is one searchable piece of text and its vector.
type Chunk struct {
	ItemID int64
	// Kind is "title" or "page_text". See migration 0004.
	Kind string
	// Lang is the language of this piece, where the archive stated one.
	Lang      string
	Ordinal   int
	Text      string
	Embedding []float32
}

// ReplaceItemChunks swaps a recording's chunks for a new set in one
// transaction, so a search never sees an item half re-indexed.
func (r *Repo) ReplaceItemChunks(ctx context.Context, itemID int64, chunks []Chunk) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `DELETE FROM discovery.chunks WHERE item_id = $1`, itemID); err != nil {
		return err
	}
	for _, c := range chunks {
		if _, err := tx.Exec(ctx, `
			INSERT INTO discovery.chunks (item_id, kind, lang, ordinal, text, embedding)
			VALUES ($1,$2,$3,$4,$5,$6)`,
			c.ItemID, c.Kind, c.Lang, c.Ordinal, c.Text, vector(c.Embedding)); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// CachedEmbeddings returns the vectors already paid for, keyed by text.
func (r *Repo) CachedEmbeddings(ctx context.Context, model string, texts []string) (map[string][]float32, error) {
	if len(texts) == 0 {
		return nil, nil
	}
	hashes := make([]string, len(texts))
	for i, t := range texts {
		hashes[i] = TextHash(t)
	}
	rows, err := r.pool.Query(ctx,
		`SELECT text, embedding FROM discovery.embeddings
		 WHERE model = $1 AND text_sha256 = ANY($2)`, model, hashes)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[string][]float32{}
	for rows.Next() {
		var text, raw string
		if err := rows.Scan(&text, &raw); err != nil {
			return nil, err
		}
		vec, err := pgvector.Parse(raw)
		if err != nil {
			return nil, err
		}
		out[text] = vec
	}
	return out, rows.Err()
}

// SaveEmbeddings records vectors so the next pass over the same words costs
// nothing.
func (r *Repo) SaveEmbeddings(ctx context.Context, model string, byText map[string][]float32) error {
	for text, vec := range byText {
		if _, err := r.pool.Exec(ctx, `
			INSERT INTO discovery.embeddings (model, text_sha256, text, embedding)
			VALUES ($1,$2,$3,$4) ON CONFLICT (model, text_sha256) DO NOTHING`,
			model, TextHash(text), text, pgvector.Literal(vec)); err != nil {
			return err
		}
	}
	return nil
}

// TextHash keys a vector by what was embedded.
func TextHash(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

// CountItems reports how many items a source has in each status.
func (r *Repo) CountItems(ctx context.Context, sourceID string) (map[string]int, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT status, count(*) FROM discovery.items
		WHERE ($1 = '' OR source_id = $1)
		GROUP BY status`, sourceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	counts := map[string]int{}
	for rows.Next() {
		var status string
		var n int
		if err := rows.Scan(&status, &n); err != nil {
			return nil, err
		}
		counts[status] = n
	}
	return counts, rows.Err()
}

// ReplaceItemRefs swaps a recording's scripture references for a new set.
// One row per verse, ordered, mirroring the corpus's track_references.
//
// origin is who is writing them. A crawl and a repair pass write the same rows
// and are not the same event, and only one of them can be undone.
func (r *Repo) ReplaceItemRefs(ctx context.Context, itemID int64, refs []domain.Ref, origin string) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx, `DELETE FROM discovery.item_refs WHERE item_id = $1`, itemID); err != nil {
		return err
	}
	for i, ref := range refs {
		if _, err := tx.Exec(ctx, `
			INSERT INTO discovery.item_refs (item_id, ref_idx, source_id, tokens, origin)
			VALUES ($1,$2,$3,$4,$5)`, itemID, i, ref.Source, ref.Tokens, origin); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// ItemRefs reads a recording's references back in order.
func (r *Repo) ItemRefs(ctx context.Context, itemID int64) ([]domain.Ref, error) {
	rows, err := r.pool.Query(ctx,
		`SELECT source_id, tokens FROM discovery.item_refs WHERE item_id = $1 ORDER BY ref_idx`, itemID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []domain.Ref
	for rows.Next() {
		var ref domain.Ref
		if err := rows.Scan(&ref.Source, &ref.Tokens); err != nil {
			return nil, err
		}
		out = append(out, ref)
	}
	return out, rows.Err()
}

// MarkMediaVanished records that a file we knew about was not on its page this
// time. Nothing is deleted: what we read before is still the best reading we
// have, and a file that comes back keeps its history.
//
// media_missing_since is set only on the first visit that misses it, so the
// column answers "gone since when" rather than "noticed again just now".
func (r *Repo) MarkMediaVanished(ctx context.Context, itemID int64, at time.Time) error {
	_, err := r.pool.Exec(ctx, `
		UPDATE discovery.items
		SET media_state = $2,
		    media_missing_since = coalesce(media_missing_since, $3)
		WHERE id = $1`, itemID, MediaVanished, at)
	return err
}

// CountMediaStates reports how many of a source's recordings are in each media
// state, so "how many files went missing" is one query rather than a tally
// kept somewhere.
func (r *Repo) CountMediaStates(ctx context.Context, sourceID string) (map[string]int, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT media_state, count(*) FROM discovery.items
		WHERE ($1 = '' OR source_id = $1)
		GROUP BY media_state`, sourceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	counts := map[string]int{}
	for rows.Next() {
		var state string
		var n int
		if err := rows.Scan(&state, &n); err != nil {
			return nil, err
		}
		counts[state] = n
	}
	return counts, rows.Err()
}

// Spend is what one model call cost. The call itself is a fact; its price is
// only known if the provider said so, so the numbers are pointers and a null
// means unreported rather than free.
type Spend struct {
	SourceID  string
	Kind      string
	Model     string
	Items     int
	TokensIn  *int64
	TokensOut *int64
	CostUSD   *float64
}

// RecordSpend keeps what a call cost, so a question about money has an answer
// that is not arithmetic.
func (r *Repo) RecordSpend(ctx context.Context, s Spend) error {
	_, err := r.pool.Exec(ctx, `
		INSERT INTO discovery.spend (source_id, kind, model, items, tokens_in, tokens_out, cost_usd)
		VALUES (nullif($1,''),$2,$3,$4,$5,$6,$7)`,
		s.SourceID, s.Kind, s.Model, s.Items, s.TokensIn, s.TokensOut, s.CostUSD)
	return err
}

// ItemText is prose an archive published about a recording, in one language.
type ItemText struct {
	Lang string
	Text string
}

// ReplaceItemTexts swaps a recording's prose of one kind for a new set, in one
// transaction.
//
// It is a replacement rather than an upsert so that a language the archive has
// stopped publishing stops being here too. Left to accumulate, a withdrawn
// translation would go on being searchable for ever with nothing to say it was
// withdrawn.
func (r *Repo) ReplaceItemTexts(ctx context.Context, itemID int64, kind string, texts []ItemText) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(ctx,
		`DELETE FROM discovery.item_texts WHERE item_id = $1 AND kind = $2`, itemID, kind); err != nil {
		return err
	}
	for _, t := range texts {
		if t.Text == "" {
			continue
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO discovery.item_texts (item_id, kind, lang, text) VALUES ($1,$2,$3,$4)
			ON CONFLICT (item_id, kind, lang) DO UPDATE SET text = EXCLUDED.text`,
			itemID, kind, t.Lang, t.Text); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// vector is a chunk's embedding on its way into the column, or NULL when there
// is none.
//
// An empty literal is "[]", which pgvector rejects outright — so one chunk
// whose vector never arrived would fail the transaction and take every other
// chunk of that recording with it. The column is nullable precisely so a piece
// of text can be stored and searched lexically while it waits for a vector.
func vector(v []float32) any {
	if len(v) == 0 {
		return nil
	}
	return pgvector.Literal(v)
}

// OriginCrawl names what wrote a reference: an ordinary visit to the page.
const OriginCrawl = "crawl"

// ItemTexts is the prose stored for one recording, one entry per language.
//
// The table was written and never read, so the promise it was added on — that
// cutting a transcript differently is a local decision rather than a reason to
// crawl a site again — could not be kept.
func (r *Repo) ItemTexts(ctx context.Context, itemID int64, kind string) ([]ItemText, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT lang, text FROM discovery.item_texts
		WHERE item_id = $1 AND kind = $2 ORDER BY lang`, itemID, kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []ItemText
	for rows.Next() {
		var t ItemText
		if err := rows.Scan(&t.Lang, &t.Text); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// ItemsAfter walks recordings by id, optionally within one source, so a repair
// can cross a corpus without holding it in memory.
func (r *Repo) ItemsAfter(ctx context.Context, sourceID string, afterID int64, limit int) ([]Item, error) {
	rows, err := r.pool.Query(ctx, `
		SELECT `+itemCols+` FROM discovery.items
		WHERE id > $1 AND ($2 = '' OR source_id = $2)
		ORDER BY id LIMIT $3`, afterID, sourceID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Item
	for rows.Next() {
		it, err := scanItem(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *it)
	}
	return out, rows.Err()
}

// ClearNormHashes drops the stored normalizer-input hash for a selection, so the
// next visit asks about those recordings again.
func (r *Repo) ClearNormHashes(ctx context.Context, sourceID string) (int64, error) {
	tag, err := r.pool.Exec(ctx, `
		UPDATE discovery.items SET norm_input_sha256 = NULL
		WHERE ($1 = '' OR source_id = $1) AND norm_input_sha256 IS NOT NULL`, sourceID)
	return tag.RowsAffected(), err
}
