// Package search answers "which recordings are about this".
//
// Two lanes run over the same chunks — vector similarity and lexical match —
// and their rankings are fused. Meaning alone misses an exact reference
// someone typed; words alone miss a paraphrase.
package search

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/lectorium/discovery/internal/domain"
	"github.com/jiva-studio/lectorium/discovery/internal/pgvector"
)

// Embedder turns the query into a vector.
type Embedder interface {
	Embed(ctx context.Context, texts []string) ([][]float32, error)
}

type Service struct {
	Pool     *pgxpool.Pool
	Embedder Embedder
}

// HitCollection places a recording inside its cycle: which one, and which part.
//
// ID is what to hand back as collection= to get the rest of the cycle. A title
// would usually work and is the wrong handle: two sources can name a cycle the
// same, and a name can be edited.
type HitCollection struct {
	ID      int64  `json:"id"`
	Title   string `json:"title"`
	URL     string `json:"url,omitempty"`
	Ordinal int    `json:"ordinal"`
	Of      int    `json:"of"`
}

// Query is free text plus the structured filters that narrow it.
type Query struct {
	Text   string
	Author string
	// AuthorIDs are the people Author resolved to, filled in before the query
	// runs so the filter can be an indexed equality rather than a text match.
	AuthorIDs []int64
	Language  string
	Source    string
	RefSource string
	RefTokens string
	// Collection narrows to one cycle, by id or by name.
	Collection string
	DateFrom   *time.Time
	DateTo     *time.Time
	Limit      int
	Offset     int
}

// Hit is one recording, with the piece of text that matched.
type Hit struct {
	ItemID     int64      `json:"item_id"`
	MediaURL   string     `json:"media_url"`
	PageURL    string     `json:"page_url,omitempty"`
	Title      string     `json:"title,omitempty"`
	Author     string     `json:"author,omitempty"`
	Location   string     `json:"location,omitempty"`
	Language   string     `json:"language,omitempty"`
	RecordedOn *time.Time `json:"recorded_on,omitempty"`
	References []string   `json:"references,omitempty"`
	Source     string     `json:"source,omitempty"`
	// Collection is the cycle this recording is a part of, and where in it.
	Collection *HitCollection `json:"collection,omitempty"`
	Chunk      string         `json:"chunk,omitempty"`
	Score      float64        `json:"score"`

	// MediaState says what the last visit saw of the file: "present", or
	// "vanished" when the address stopped appearing on its page. A vanished
	// recording is still worth returning — knowing a talk exists is not
	// nothing.
	MediaState string `json:"media_state,omitempty"`
}

const (
	// candidates is how deep each lane goes before fusing. Wider than the page
	// so fusion has something to work with.
	candidates = 60
	// efSearch widens the HNSW graph walk. A selective filter discards most of
	// what the walk finds, so the walk has to find more.
	efSearch = 80
	// exactScanMax is the number of surviving rows below which an exact
	// distance scan beats the index. At this corpus size a filter on one
	// author leaves few enough rows that exact search is both faster and
	// perfectly recalled.
	exactScanMax = 20000
	// rrfK damps the contribution of low-ranked hits in the fusion.
	rrfK = 60
)

// resolveAuthors turns a written name into the people it could mean, running
// over the authors rather than over the recordings so that the filter itself
// can stay an indexed equality.
//
// A name that names somebody exactly means that person and nobody else.
// Widening to everyone whose name merely starts the same way would answer
// "Radhanath Swami" with a dozen people, most of them joint recordings he
// happens to appear in. Only a name that matches nobody falls back to a loose
// match, which is what makes a partial name work.
func (s *Service) resolveAuthors(ctx context.Context, name string) ([]int64, error) {
	rows, err := s.Pool.Query(ctx, `
		WITH exact AS (
			SELECT k.author_id AS id FROM discovery.author_keys k WHERE k.key = $2
		)
		SELECT id FROM exact
		UNION
		SELECT a.id
		FROM discovery.authors a
		LEFT JOIN discovery.author_keys k ON k.author_id = a.id
		WHERE NOT EXISTS (SELECT 1 FROM exact)
		  AND (k.key LIKE $2 || '%' OR a.name ILIKE '%' || $1 || '%')`, name, domain.Key(name))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// noAuthor stands in when a name matches nobody, so the search returns nothing
// rather than dropping the filter.
const noAuthor = -1

func (s *Service) prepare(ctx context.Context, q *Query) error {
	if q.Author == "" || len(q.AuthorIDs) > 0 {
		return nil
	}
	ids, err := s.resolveAuthors(ctx, q.Author)
	if err != nil {
		return err
	}
	if len(ids) == 0 {
		ids = []int64{noAuthor}
	}
	q.AuthorIDs = ids
	return nil
}

// Search runs both lanes and fuses them.
func (s *Service) Search(ctx context.Context, q Query) ([]Hit, error) {
	if q.Limit <= 0 || q.Limit > 100 {
		q.Limit = 20
	}
	if err := s.prepare(ctx, &q); err != nil {
		return nil, err
	}
	if strings.TrimSpace(q.Text) == "" {
		return s.filterOnly(ctx, q)
	}

	var vector, lexical []Hit
	if s.Embedder != nil {
		vecs, err := s.Embedder.Embed(ctx, []string{q.Text})
		if err != nil {
			return nil, fmt.Errorf("embed query: %w", err)
		}
		if vector, err = s.vector(ctx, q, vecs[0]); err != nil {
			return nil, err
		}
	}
	lexical, err := s.lexical(ctx, q)
	if err != nil {
		return nil, err
	}
	return fuse(q, vector, lexical), nil
}

// filters builds the WHERE shared by both lanes, and reports how selective it
// is expected to be.
func (s *Service) filters(q Query, args []any) ([]string, []any) {
	var where []string
	add := func(clause string, value any) {
		args = append(args, value)
		where = append(where, fmt.Sprintf(clause, len(args)))
	}
	// The name is resolved to people before the query runs; a text match here
	// would cost both lanes their index on items.
	if len(q.AuthorIDs) > 0 {
		add("EXISTS (SELECT 1 FROM discovery.item_authors ia WHERE ia.item_id = i.id AND ia.author_id = ANY($%d))",
			q.AuthorIDs)
	}
	if q.Language != "" {
		add("i.language = $%d", q.Language)
	}
	if q.Source != "" {
		add("i.source_id = $%d", q.Source)
	}
	// A recording matches when ANY of its references does — a talk covering
	// sixty verses is findable by every one of them.
	if q.RefSource != "" {
		add("EXISTS (SELECT 1 FROM discovery.item_refs r WHERE r.item_id = i.id AND r.source_id = $%d)",
			strings.ToUpper(q.RefSource))
	}
	if q.RefTokens != "" {
		add("EXISTS (SELECT 1 FROM discovery.item_refs r WHERE r.item_id = i.id AND r.tokens = $%d)",
			q.RefTokens)
	}
	if q.Collection != "" {
		// A cycle can be named or numbered; both are how a person has it to
		// hand, so both work.
		add(`EXISTS (SELECT 1 FROM discovery.collection_members m
		             JOIN discovery.collections col ON col.id = m.collection_id
		             WHERE m.item_id = i.id
		               AND (col.title ILIKE $%[1]d OR col.id::text = $%[1]d))`,
			q.Collection)
	}
	if q.DateFrom != nil {
		add("i.recorded_on >= $%d", *q.DateFrom)
	}
	if q.DateTo != nil {
		add("i.recorded_on <= $%d", *q.DateTo)
	}
	return where, args
}

func (q Query) filtered() bool {
	return len(q.AuthorIDs) > 0 || q.Language != "" || q.Source != "" ||
		q.RefSource != "" || q.RefTokens != "" || q.Collection != "" ||
		q.DateFrom != nil || q.DateTo != nil
}

const hitCols = `i.id, i.media_url, coalesce(p.url,''), coalesce(i.title,''),
	coalesce(i.author,''), coalesce(i.location,''), coalesce(i.language,''),
	i.recorded_on, ` + refsCol + `,
	coalesce(i.source_id,''), i.media_state,
	coll.id, coll.title, coll.url, coll.ordinal, coll.of, c.text`

// collectionJoin hangs the cycle off each hit. LEFT so a recording that
// belongs to none still comes back, and a cycle of one part is not offered.
const collectionJoin = `
	LEFT JOIN LATERAL (
		SELECT col.id, col.title, col.url, m.ordinal, k.n
		FROM discovery.collection_members m
		JOIN discovery.collections col ON col.id = m.collection_id
		CROSS JOIN LATERAL (SELECT count(*) FROM discovery.collection_members x
		                    WHERE x.collection_id = col.id) k(n)
		WHERE m.item_id = i.id AND (col.url IS NOT NULL OR k.n >= 2)
		ORDER BY col.id LIMIT 1
	) coll(id, title, url, ordinal, of) ON TRUE`

// refsCol collects a recording's references into one array, in their own
// order, so a hit shows every passage it is about rather than an arbitrary one.
const refsCol = `coalesce((SELECT array_agg(trim(r.source_id || ' ' || r.tokens) ORDER BY r.ref_idx)
	FROM discovery.item_refs r WHERE r.item_id = i.id), '{}')`

func scanHits(rows pgx.Rows) ([]Hit, error) {
	defer rows.Close()
	var out []Hit
	for rows.Next() {
		var h Hit
		var collID *int64
		var title, url *string
		var ordinal, of *int
		if err := rows.Scan(&h.ItemID, &h.MediaURL, &h.PageURL, &h.Title, &h.Author,
			&h.Location, &h.Language, &h.RecordedOn, &h.References, &h.Source,
			&h.MediaState, &collID, &title, &url, &ordinal, &of,
			&h.Chunk, &h.Score); err != nil {
			return nil, err
		}
		if collID != nil && title != nil && ordinal != nil {
			h.Collection = &HitCollection{ID: *collID, Title: *title, Ordinal: *ordinal + 1}
			if url != nil {
				h.Collection.URL = *url
			}
			if of != nil {
				h.Collection.Of = *of
			}
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// vector runs approximate nearest-neighbour search, or an exact scan when the
// filter has left few enough rows that exact is both faster and complete.
//
// This is the failure mode worth designing against: HNSW walks the graph
// first and applies the WHERE afterwards, so a narrow filter can discard
// nearly every candidate and quietly return half a page of results.
func (s *Service) vector(ctx context.Context, q Query, vec []float32) ([]Hit, error) {
	where, args := s.filters(q, []any{})
	args = append(args, pgvector.Literal(vec))
	vecPos := len(args)
	args = append(args, candidates)
	limPos := len(args)

	clause := "TRUE"
	if len(where) > 0 {
		clause = strings.Join(where, " AND ")
	}
	sql := fmt.Sprintf(`
		SELECT %s, 1 - (c.embedding <=> $%d::vector) AS score
		FROM discovery.chunks c
		JOIN discovery.items i ON i.id = c.item_id
		LEFT JOIN discovery.pages p ON p.id = i.page_id`+collectionJoin+`
		WHERE c.embedding IS NOT NULL AND %s
		ORDER BY c.embedding <=> $%d::vector
		LIMIT $%d`, hitCols, vecPos, clause, vecPos, limPos)

	tx, err := s.Pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	exact, err := s.useExactScan(ctx, tx, q)
	if err != nil {
		return nil, err
	}
	if exact {
		// Turning the index off is the point: with few rows surviving the
		// filter, scanning them all is fast and recalls everything.
		if _, err := tx.Exec(ctx, "SET LOCAL enable_indexscan = off"); err != nil {
			return nil, err
		}
	} else {
		if _, err := tx.Exec(ctx, "SET LOCAL hnsw.iterative_scan = relaxed_order"); err != nil {
			return nil, fmt.Errorf("set iterative_scan: %w", err)
		}
		if _, err := tx.Exec(ctx, fmt.Sprintf("SET LOCAL hnsw.ef_search = %d", efSearch)); err != nil {
			return nil, fmt.Errorf("set ef_search: %w", err)
		}
	}

	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return scanHits(rows)
}

// useExactScan reports whether the filter is narrow enough that an exact
// distance scan is the better plan.
func (s *Service) useExactScan(ctx context.Context, tx pgx.Tx, q Query) (bool, error) {
	if !q.filtered() {
		return false, nil
	}
	where, args := s.filters(q, []any{})
	sql := `SELECT count(*) FROM discovery.chunks c JOIN discovery.items i ON i.id = c.item_id
		WHERE ` + strings.Join(where, " AND ")

	var n int
	if err := tx.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
		return false, err
	}
	return n <= exactScanMax, nil
}

// lexical matches the words themselves. Postgres ships no configuration for
// several of the languages here, so the simple configuration is used
// throughout: no stemming, but no wrong stemming either.
func (s *Service) lexical(ctx context.Context, q Query) ([]Hit, error) {
	where, args := s.filters(q, []any{q.Text})
	clause := append([]string{"to_tsvector('simple', c.text) @@ websearch_to_tsquery('simple', $1)"}, where...)
	args = append(args, candidates)

	sql := fmt.Sprintf(`
		SELECT %s, ts_rank(to_tsvector('simple', c.text), websearch_to_tsquery('simple', $1)) AS score
		FROM discovery.chunks c
		JOIN discovery.items i ON i.id = c.item_id
		LEFT JOIN discovery.pages p ON p.id = i.page_id`+collectionJoin+`
		WHERE %s
		ORDER BY score DESC
		LIMIT $%d`, hitCols, strings.Join(clause, " AND "), len(args))

	rows, err := s.Pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return scanHits(rows)
}

// filterOnly answers a query that is pure filters: no text to match, just
// "everything by this speaker on this verse".
func (s *Service) filterOnly(ctx context.Context, q Query) ([]Hit, error) {
	where, args := s.filters(q, []any{})
	clause := "TRUE"
	if len(where) > 0 {
		clause = strings.Join(where, " AND ")
	}
	args = append(args, q.Limit, q.Offset)

	sql := fmt.Sprintf(`
		SELECT i.id, i.media_url, coalesce(p.url,''), coalesce(i.title,''),
			coalesce(i.author,''), coalesce(i.location,''), coalesce(i.language,''),
			i.recorded_on, `+refsCol+`,
			coalesce(i.source_id,''), i.media_state,
			coll.id, coll.title, coll.url, coll.ordinal, coll.of, '' AS text, 0::float8 AS score
		FROM discovery.items i
		LEFT JOIN discovery.pages p ON p.id = i.page_id`+collectionJoin+`
		WHERE %s
		ORDER BY coll.ordinal NULLS LAST, i.recorded_on DESC NULLS LAST, i.id
		LIMIT $%d OFFSET $%d`, clause, len(args)-1, len(args))

	rows, err := s.Pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return scanHits(rows)
}

// fuse merges the two rankings by reciprocal rank. Scores from an ANN search
// and from ts_rank are not on the same scale and cannot be added; their
// positions can.
func fuse(q Query, lanes ...[]Hit) []Hit {
	type acc struct {
		hit   Hit
		score float64
	}
	byItem := map[int64]*acc{}
	var order []int64

	for _, lane := range lanes {
		for rank, h := range lane {
			a, ok := byItem[h.ItemID]
			if !ok {
				a = &acc{hit: h}
				byItem[h.ItemID] = a
				order = append(order, h.ItemID)
			}
			a.score += 1 / float64(rrfK+rank+1)
			// Keep whichever lane's chunk ranked highest as the shown excerpt.
			if a.hit.Chunk == "" {
				a.hit.Chunk = h.Chunk
			}
		}
	}

	out := make([]Hit, 0, len(order))
	for _, id := range order {
		a := byItem[id]
		a.hit.Score = a.score
		out = append(out, a.hit)
	}
	// Stable ordering by fused score, highest first.
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].Score > out[j-1].Score; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}

	if q.Offset >= len(out) {
		return nil
	}
	out = out[q.Offset:]
	if len(out) > q.Limit {
		out = out[:q.Limit]
	}
	return out
}
