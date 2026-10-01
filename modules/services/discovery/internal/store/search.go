package store

import (
	"context"
	"fmt"
	"strings"
	"unicode"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti/discovery/internal/domain"
	"github.com/jiva-studio/shruti/discovery/internal/pgvector"
)

// SearchIndex answers searches over the chunks: by distance between vectors,
// by the words themselves, and by filters alone.
type SearchIndex struct {
	pool *pgxpool.Pool
}

func NewSearchIndex(pool *pgxpool.Pool) *SearchIndex { return &SearchIndex{pool: pool} }

const (
	// efSearch widens the HNSW graph walk. A selective filter discards most of
	// what the walk finds, so the walk has to find more.
	efSearch = 80
	// exactScanMax is the number of surviving rows below which an exact
	// distance scan beats the index. At this corpus size a filter on one
	// author leaves few enough rows that exact search is both faster and
	// perfectly recalled.
	exactScanMax = 20000
)

// searchFilters builds the WHERE shared by every lane, numbering its
// parameters after the ones already in args.
func searchFilters(f domain.SearchFilter, args []any) ([]string, []any) {
	// A recording the archive stopped offering is not an answer. The row stays,
	// with the date it went missing, for a person to settle.
	where := []string{"i.media_state <> '" + domain.MediaVanished + "'"}
	add := func(clause string, value any) {
		args = append(args, value)
		where = append(where, fmt.Sprintf(clause, len(args)))
	}
	// The name is resolved to people before the query runs; a text match here
	// would cost both lanes their index on items.
	if len(f.AuthorIDs) > 0 {
		add("EXISTS (SELECT 1 FROM discovery.item_authors ia WHERE ia.item_id = i.id AND ia.author_id = ANY($%d))",
			f.AuthorIDs)
	}
	if len(f.Languages) > 0 {
		add("i.language = ANY($%d)", f.Languages)
	}
	// A recording matches when ANY of its references does — a talk covering
	// sixty verses is findable by every one of them.
	//
	// One clause, not two. Asked separately, "cites BG" and "cites something
	// numbered 4" would be satisfied by different references on the same
	// recording, so a talk on ISO 4 that mentions the Bhagavatam once would
	// match SB 4. The more verses a recording covers, the more coordinates it
	// would answer to.
	codes := make([]string, 0, len(f.Sources))
	for _, c := range f.Sources {
		if c = strings.ToUpper(strings.TrimSpace(c)); c != "" {
			codes = append(codes, c)
		}
	}
	switch {
	case len(codes) > 0 && f.Tokens != "":
		args = append(args, codes, f.Tokens)
		where = append(where, fmt.Sprintf(
			"EXISTS (SELECT 1 FROM discovery.item_refs r WHERE r.item_id = i.id AND r.source_id = ANY($%d) AND r.tokens = $%d)",
			len(args)-1, len(args)))
	case len(codes) > 0:
		add("EXISTS (SELECT 1 FROM discovery.item_refs r WHERE r.item_id = i.id AND r.source_id = ANY($%d))", codes)
	case f.Tokens != "":
		add("EXISTS (SELECT 1 FROM discovery.item_refs r WHERE r.item_id = i.id AND r.tokens = $%d)", f.Tokens)
	}
	if f.Collection != "" {
		// A cycle can be named or numbered; both are how a person has it to
		// hand, so both work.
		add(`EXISTS (SELECT 1 FROM discovery.collection_members m
		             JOIN discovery.collections col ON col.id = m.collection_id
		             WHERE m.item_id = i.id
               AND (col.title ILIKE $%[1]d OR col.id::text = $%[1]d))`,
			f.Collection)
	}
	if f.DateFrom != nil {
		add("i.recorded_on >= $%d", *f.DateFrom)
	}
	if f.DateTo != nil {
		add("i.recorded_on <= $%d", *f.DateTo)
	}
	return where, args
}

const hitCols = `i.id, i.media_url, coalesce(p.url,''), coalesce(i.title,''),
	coalesce(i.author,''), coalesce(i.location,''), coalesce(i.language,''),
	coalesce(i.cover_url,''), i.recorded_on, ` + refsCol + `,
	coalesce(i.source_id,''), i.media_state,
	coll.id, coll.title, coll.url, coll.ordinal, coll.of, m.text, m.score`

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

func scanHits(rows pgx.Rows) ([]domain.Hit, error) {
	defer rows.Close()
	var out []domain.Hit
	for rows.Next() {
		var h domain.Hit
		var collID *int64
		var title, url *string
		var ordinal, of *int
		if err := rows.Scan(&h.ItemID, &h.MediaURL, &h.PageURL, &h.Title, &h.Author,
			&h.Location, &h.Language, &h.CoverURL, &h.RecordedOn, &h.References, &h.Source,
			&h.MediaState, &collID, &title, &url, &ordinal, &of,
			&h.Chunk, &h.Score); err != nil {
			return nil, err
		}
		if collID != nil && title != nil && ordinal != nil {
			h.Collection = &domain.HitCollection{ID: *collID, Title: *title, Ordinal: *ordinal + 1}
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

// Nearest runs approximate nearest-neighbour search, or an exact scan when the
// filter has left few enough rows that exact is both faster and complete.
//
// This is the failure mode worth designing against: HNSW walks the graph
// first and applies the WHERE afterwards, so a narrow filter can discard
// nearly every candidate and quietly return half a page of results.
func (s *SearchIndex) Nearest(ctx context.Context, f domain.SearchFilter, vec []float32, limit int) ([]domain.Hit, error) {
	where, args := searchFilters(f, []any{})
	args = append(args, pgvector.Literal(vec))
	vecPos := len(args)
	args = append(args, limit)
	limPos := len(args)

	clause := "TRUE"
	if len(where) > 0 {
		clause = strings.Join(where, " AND ")
	}
	sql := fmt.Sprintf(`
		WITH matched AS (
			SELECT c.id AS chunk_id, c.item_id, c.text,
			       1 - (c.embedding <=> $%d::vector) AS score
			FROM discovery.chunks c
			JOIN discovery.items i ON i.id = c.item_id
			WHERE c.embedding IS NOT NULL AND %s
			ORDER BY c.embedding <=> $%d::vector
			LIMIT $%d
		)
		SELECT %s
		FROM matched m
		JOIN discovery.items i ON i.id = m.item_id
		LEFT JOIN discovery.pages p ON p.id = i.page_id`+collectionJoin+`
		ORDER BY m.score DESC`, vecPos, clause, vecPos, limPos, hitCols)

	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	exact, err := useExactScan(ctx, tx, f)
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
func useExactScan(ctx context.Context, tx pgx.Tx, f domain.SearchFilter) (bool, error) {
	if !f.Narrowed() {
		return false, nil
	}
	where, args := searchFilters(f, []any{})
	sql := `SELECT count(*) FROM discovery.chunks c JOIN discovery.items i ON i.id = c.item_id
		WHERE ` + strings.Join(where, " AND ")

	var n int
	if err := tx.QueryRow(ctx, sql, args...).Scan(&n); err != nil {
		return false, err
	}
	return n <= exactScanMax, nil
}

// Both lexical lanes match words in the detected natural language configuration (e.g. 'russian', 'english', 'simple').

// AllWords finds the chunks that hold every word of the text.
func (s *SearchIndex) AllWords(ctx context.Context, f domain.SearchFilter, text, langConfig string, limit int) ([]domain.Hit, error) {
	return s.lexical(ctx, f, text, langConfig, false, limit)
}

// AnyWord finds the chunks that hold any word of the text, ranked by relevance.
func (s *SearchIndex) AnyWord(ctx context.Context, f domain.SearchFilter, text, langConfig string, limit int) ([]domain.Hit, error) {
	return s.lexical(ctx, f, text, langConfig, true, limit)
}

func (s *SearchIndex) lexical(ctx context.Context, f domain.SearchFilter, text, langConfig string, anyWord bool, limit int) ([]domain.Hit, error) {
	if strings.TrimSpace(text) == "" {
		return nil, nil
	}
	if langConfig == "" {
		langConfig = "simple"
	}

	where, args := searchFilters(f, []any{})

	var queryParam string
	if anyWord {
		// Loosened query: match any word using OR
		words := strings.Fields(text)
		var cleaned []string
		for _, w := range words {
			w = strings.Map(func(r rune) rune {
				if unicode.IsLetter(r) || unicode.IsDigit(r) {
					return r
				}
				return -1
			}, w)
			if w != "" {
				cleaned = append(cleaned, w)
			}
		}
		if len(cleaned) == 0 {
			return nil, nil
		}
		queryParam = strings.Join(cleaned, " or ")
	} else {
		queryParam = text
	}

	args = append(args, langConfig, queryParam)
	langPos := len(args) - 1
	qPos := len(args)

	queryExpr := fmt.Sprintf("websearch_to_tsquery($%d::regconfig, $%d)", langPos, qPos)
	matchClause := fmt.Sprintf("to_tsvector($%d::regconfig, c.text) @@ %s", langPos, queryExpr)
	scoreExpr := fmt.Sprintf("ts_rank(to_tsvector($%d::regconfig, c.text), %s)", langPos, queryExpr)

	clause := append([]string{matchClause}, where...)
	args = append(args, limit)
	limPos := len(args)

	sql := fmt.Sprintf(`
		WITH matched AS (
			SELECT c.id AS chunk_id, c.item_id, c.text,
			       %s AS score
			FROM discovery.chunks c
			JOIN discovery.items i ON i.id = c.item_id
			WHERE %s
			ORDER BY score DESC
			LIMIT $%d
		)
		SELECT %s
		FROM matched m
		JOIN discovery.items i ON i.id = m.item_id
		LEFT JOIN discovery.pages p ON p.id = i.page_id`+collectionJoin+`
		ORDER BY m.score DESC`, scoreExpr, strings.Join(clause, " AND "), limPos, hitCols)

	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return scanHits(rows)
}

// Filtered answers a query that is pure filters: no text to match, just
// "everything by this speaker on this verse", a cycle in its own order and the
// rest newest first.
func (s *SearchIndex) Filtered(ctx context.Context, f domain.SearchFilter, limit, offset int) ([]domain.Hit, error) {
	where, args := searchFilters(f, []any{})
	clause := "TRUE"
	if len(where) > 0 {
		clause = strings.Join(where, " AND ")
	}
	args = append(args, limit, offset)

	sql := fmt.Sprintf(`
		SELECT i.id, i.media_url, coalesce(p.url,''), coalesce(i.title,''),
			coalesce(i.author,''), coalesce(i.location,''), coalesce(i.language,''),
			coalesce(i.cover_url,''), i.recorded_on, `+refsCol+`,
			coalesce(i.source_id,''), i.media_state,
			coll.id, coll.title, coll.url, coll.ordinal, coll.of, '' AS text, 0::float8 AS score
		FROM discovery.items i
		LEFT JOIN discovery.pages p ON p.id = i.page_id`+collectionJoin+`
		WHERE %s
		ORDER BY coll.ordinal NULLS LAST, i.recorded_on DESC NULLS LAST, i.id
		LIMIT $%d OFFSET $%d`, clause, len(args)-1, len(args))

	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return scanHits(rows)
}
