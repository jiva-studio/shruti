package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/jiva-studio/shruti/discovery/internal/domain"
	"github.com/jiva-studio/shruti/discovery/internal/pgvector"
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

	// Raw is everything extraction found, kept so a prompt change can be
	// replayed without refetching the page.
	Raw json.RawMessage

	Title           string
	Author          string
	Location        string
	RecordedOn      *time.Time
	Language        string
	DurationS       int
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
	media_state, media_seen_at, media_missing_since,
	coalesce(norm_input_sha256,''), coalesce(norm_prompt_version,''), coalesce(norm_model,''),
	status, first_seen_at, last_seen_at`

func scanItem(row pgx.Row) (*Item, error) {
	var it Item
	err := row.Scan(&it.ID, &it.MediaURL, &it.SourceID, &it.PageID, &it.Raw,
		&it.Title, &it.Author, &it.Location, &it.RecordedOn,
		&it.Language, &it.DurationS, &it.CollectionTitle,
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
	return it, nil
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
	if it.Raw == nil {
		it.Raw = json.RawMessage(`{}`)
	}
	if it.Status == "" {
		it.Status = StatusDiscovered
	}
	if it.MediaState == "" {
		it.MediaState = MediaPresent
	}
	err = r.pool.QueryRow(ctx, `
		INSERT INTO discovery.items
			(media_url, source_id, page_id, raw, title, author, location, recorded_on,
			 language, duration_s, collection_title,
			 media_state, media_seen_at, media_missing_since,
			 norm_input_sha256, norm_prompt_version, norm_model, status)
		VALUES ($1,$2,$3,$4,nullif($5,''),nullif($6,''),nullif($7,''),$8,
			 nullif($9,''),nullif($10,0),nullif($11,''),
			 $12,$13,NULL,
			 nullif($14,''),nullif($15,''),nullif($16,''),$17)
		ON CONFLICT (media_url) DO UPDATE SET
			source_id           = coalesce(EXCLUDED.source_id, discovery.items.source_id),
			page_id             = coalesce(EXCLUDED.page_id, discovery.items.page_id),
			raw                 = EXCLUDED.raw,
			title               = EXCLUDED.title,
			author              = EXCLUDED.author,
			location            = EXCLUDED.location,
			recorded_on         = EXCLUDED.recorded_on,
			language            = EXCLUDED.language,
			duration_s          = EXCLUDED.duration_s,
			collection_title    = EXCLUDED.collection_title,
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
		it.MediaURL, it.SourceID, it.PageID, it.Raw, it.Title, it.Author, it.Location, it.RecordedOn,
		it.Language, it.DurationS, it.CollectionTitle,
		it.MediaState, it.MediaSeenAt,
		it.NormInputSHA256, it.NormPromptVersion, it.NormModel, it.Status,
	).Scan(&it.ID, &isNew)
	return isNew, err
}

// TouchItem records that a file is still there without rewriting anything we
// already know about it.
func (r *Repo) TouchItem(ctx context.Context, id int64) error {
	_, err := r.pool.Exec(ctx, `UPDATE discovery.items SET last_seen_at = now() WHERE id = $1`, id)
	return err
}

// Chunk is one searchable piece of text and its vector.
type Chunk struct {
	ItemID    *int64
	PageID    *int64
	SourceID  *string
	Language  string
	Role      string
	Ordinal   int
	Text      string
	Embedding []float32
}

// ReplaceItemChunks swaps an item's chunks for a new set in one transaction,
// so a search never sees an item half re-indexed.
func (r *Repo) ReplaceItemChunks(ctx context.Context, itemID int64, chunks []Chunk) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `DELETE FROM discovery.chunks WHERE item_id = $1`, itemID); err != nil {
		return err
	}
	for _, c := range chunks {
		if _, err := tx.Exec(ctx, `
			INSERT INTO discovery.chunks
				(item_id, page_id, source_id, language, role, ordinal, text, embedding)
			VALUES ($1,$2,$3,nullif($4,''),$5,$6,$7,$8::vector)`,
			itemID, c.PageID, c.SourceID, c.Language, c.Role, c.Ordinal, c.Text,
			pgvector.Literal(c.Embedding),
		); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
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
func (r *Repo) ReplaceItemRefs(ctx context.Context, itemID int64, refs []domain.Ref) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `DELETE FROM discovery.item_refs WHERE item_id = $1`, itemID); err != nil {
		return err
	}
	for i, ref := range refs {
		if _, err := tx.Exec(ctx, `
			INSERT INTO discovery.item_refs (item_id, ref_idx, source_id, tokens)
			VALUES ($1,$2,$3,$4)`, itemID, i, ref.Source, ref.Tokens); err != nil {
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

// Author is one speaker: the name to show, every spelling the archive filed
// them under, and how much of them there is.
type Author struct {
	Key      string   `json:"key"`
	Name     string   `json:"name"`
	Variants []string `json:"variants,omitempty"`
	Items    int      `json:"items"`
}

// Authors lists the speakers of a source, most recorded first.
//
// The name shown is the commonest spelling rather than a made-up canonical
// one: whichever form the archive used most is the form its readers will
// recognise, and inventing a fifth spelling to sit alongside the four that
// exist helps nobody.
func (r *Repo) Authors(ctx context.Context, sourceID string, limit int) ([]Author, error) {
	rows, err := r.pool.Query(ctx, `
		WITH spelling AS (
			SELECT author_key, author, count(*) AS n
			FROM discovery.items
			WHERE author_key IS NOT NULL AND ($1 = '' OR source_id = $1)
			GROUP BY author_key, author
		)
		SELECT author_key,
		       (array_agg(author ORDER BY n DESC, author))[1],
		       array_agg(author ORDER BY n DESC, author),
		       sum(n)::int
		FROM spelling
		GROUP BY author_key
		ORDER BY sum(n) DESC, author_key
		LIMIT $2`, sourceID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Author
	for rows.Next() {
		var a Author
		if err := rows.Scan(&a.Key, &a.Name, &a.Variants, &a.Items); err != nil {
			return nil, err
		}
		if len(a.Variants) < 2 {
			a.Variants = nil
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
