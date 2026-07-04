// Package search runs the read-only retrieval queries over the chunks +
// chunk_embeddings_d<dim> tables. Absorbed from search-mcp — the SQL mirrors
// chat's pg_chunk_repository (vector ANN + lexical FTS/trigram, RRF fusion) so
// a hit here is the same chunk chat would retrieve. `search` maps chunk kinds
// to the corpus `types` (verse / document / track / title).
package search

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/config"
	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/pgvector"
)

// Hit is one returned chunk. Pointer fields are NULL for chunk kinds that
// don't carry them (item_id/source_id/... are NULL on transcripts; start_ms/
// end_ms are NULL on library chunks).
type Hit struct {
	ChunkID   int64   `json:"chunk_id"`
	Kind      string  `json:"kind"`
	Score     float64 `json:"score"`
	Lang      string  `json:"lang"`
	Text      string  `json:"text"`
	ItemID    *string `json:"item_id,omitempty"`
	TrackID   *string `json:"track_id,omitempty"`
	SourceID  *string `json:"source_id,omitempty"`
	Tokens    *string `json:"tokens,omitempty"`
	AuthorID  *string `json:"author_id,omitempty"`
	AddrLabel *string `json:"addr_label,omitempty"`
	StartMs   *int32  `json:"start_ms,omitempty"`
	EndMs     *int32  `json:"end_ms,omitempty"`
}

// Repo holds the pool + the active embed_model / per-dim embedding table.
type Repo struct {
	pool      *pgxpool.Pool
	embedTbl  string
	embedName string
}

func NewRepo(pool *pgxpool.Pool, cfg config.Config) *Repo {
	return &Repo{pool: pool, embedTbl: cfg.ChunkTable(), embedName: cfg.EmbedModel}
}

const selectCols = `c.id, c.kind, c.lang, c.text, c.item_id, c.track_id,
	c.source_id, c.tokens, c.author_id, c.addr_label, c.start_ms, c.end_ms`

func scanHits(rows pgx.Rows) ([]Hit, error) {
	defer rows.Close()
	var out []Hit
	for rows.Next() {
		var h Hit
		if err := rows.Scan(&h.ChunkID, &h.Kind, &h.Lang, &h.Text, &h.ItemID,
			&h.TrackID, &h.SourceID, &h.Tokens, &h.AuthorID, &h.AddrLabel,
			&h.StartMs, &h.EndMs, &h.Score); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// Vector runs pure ANN cosine search. trackIDs, when non-empty, restricts to
// those chunks (c.track_id = ANY) — the caller pre-resolved a reference filter.
func (r *Repo) Vector(ctx context.Context, vec []float32, kinds []string, lang string, limit int, trackIDs []string) ([]Hit, error) {
	where := []string{"c.embed_model = $1"}
	args := []any{r.embedName}
	if len(kinds) > 0 {
		where = append(where, fmt.Sprintf("c.kind = ANY($%d::text[])", len(args)+1))
		args = append(args, kinds)
	}
	if lang != "" {
		where = append(where, fmt.Sprintf("c.lang = $%d", len(args)+1))
		args = append(args, lang)
	}
	if len(trackIDs) > 0 {
		where = append(where, fmt.Sprintf("c.track_id = ANY($%d::text[])", len(args)+1))
		args = append(args, trackIDs)
	}
	vecLit := pgvector.Literal(vec)
	args = append(args, vecLit)
	vecPos := len(args)
	args = append(args, limit)
	limPos := len(args)

	sql := fmt.Sprintf(`
		SELECT %s, 1 - (e.embedding <=> $%d::vector) AS score
		FROM chunks c
		JOIN %s e ON e.chunk_id = c.id
		WHERE %s
		ORDER BY e.embedding <=> $%d::vector
		LIMIT $%d`,
		selectCols, vecPos, r.embedTbl, strings.Join(where, " AND "), vecPos, limPos)

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, "SET LOCAL hnsw.iterative_scan = relaxed_order"); err != nil {
		return nil, fmt.Errorf("set iterative_scan: %w", err)
	}
	if _, err := tx.Exec(ctx, "SET LOCAL hnsw.ef_search = 80"); err != nil {
		return nil, fmt.Errorf("set ef_search: %w", err)
	}
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return scanHits(rows)
}

// Lexical runs FTS (russian + simple) OR trigram-address recall. trackIDs,
// when non-empty, restricts to those chunks (c.track_id = ANY).
func (r *Repo) Lexical(ctx context.Context, query string, vec []float32, kinds []string, lang string, limit int, trgmMinSim float64, trackIDs []string) ([]Hit, error) {
	if strings.TrimSpace(query) == "" {
		return nil, nil
	}
	where := []string{
		"c.embed_model = $1",
		`(to_tsvector('russian', c.text) @@ websearch_to_tsquery('russian', $2)
		  OR to_tsvector('simple', c.text) @@ websearch_to_tsquery('simple', $2)
		  OR (c.source_id IS NOT NULL AND
		      (coalesce(c.addr_label,'') || ' ' || coalesce(c.source_id,'')
		       || ' ' || coalesce(c.tokens,'')) % $2))`,
	}
	args := []any{r.embedName, query}
	if len(kinds) > 0 {
		where = append(where, fmt.Sprintf("c.kind = ANY($%d::text[])", len(args)+1))
		args = append(args, kinds)
	}
	if lang != "" {
		where = append(where, fmt.Sprintf("c.lang = $%d", len(args)+1))
		args = append(args, lang)
	}
	if len(trackIDs) > 0 {
		where = append(where, fmt.Sprintf("c.track_id = ANY($%d::text[])", len(args)+1))
		args = append(args, trackIDs)
	}
	vecLit := pgvector.Literal(vec)
	args = append(args, vecLit)
	vecPos := len(args)
	args = append(args, limit)
	limPos := len(args)

	sql := fmt.Sprintf(`
		SELECT %s, 1 - (e.embedding <=> $%d::vector) AS score
		FROM chunks c
		JOIN %s e ON e.chunk_id = c.id
		WHERE %s
		ORDER BY GREATEST(
			ts_rank(to_tsvector('russian', c.text), websearch_to_tsquery('russian', $2)),
			ts_rank(to_tsvector('simple',  c.text), websearch_to_tsquery('simple',  $2)),
			CASE WHEN c.source_id IS NOT NULL
			     THEN similarity(coalesce(c.addr_label,'') || ' ' || coalesce(c.source_id,'')
			          || ' ' || coalesce(c.tokens,''), $2)
			     ELSE 0 END
		) DESC
		LIMIT $%d`,
		selectCols, vecPos, r.embedTbl, strings.Join(where, " AND "), limPos)

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, "SELECT set_config('pg_trgm.similarity_threshold', $1, true)", fmt.Sprintf("%g", trgmMinSim)); err != nil {
		return nil, fmt.Errorf("set trgm threshold: %w", err)
	}
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return scanHits(rows)
}

// Hybrid fuses Vector + Lexical by Reciprocal Rank Fusion. trackIDs, when
// non-empty, restricts both lanes to those chunks (a pre-resolved reference
// filter, e.g. track-only search under a source/tokens).
// LaneTimings reports how long each Hybrid lane took (ms) — logged per search
// so we can tell whether the vector or the lexical lane dominates latency.
type LaneTimings struct {
	VectorMs  int64
	LexicalMs int64
}

func (r *Repo) Hybrid(ctx context.Context, query string, vec []float32, kinds []string, lang string, limit int, trgmMinSim float64, trackIDs []string) ([]Hit, LaneTimings, error) {
	const rrfK = 60
	// Run the two independent lanes concurrently — each is a separate DB
	// round-trip, so this roughly halves Hybrid latency. Error semantics are
	// preserved: if either lane fails, return that (wrapped) error.
	var (
		wg         sync.WaitGroup
		vres, lres []Hit
		verr, lerr error
		lt         LaneTimings
	)
	wg.Add(2)
	go func() {
		defer wg.Done()
		t := time.Now()
		vres, verr = r.Vector(ctx, vec, kinds, lang, limit, trackIDs)
		lt.VectorMs = time.Since(t).Milliseconds()
	}()
	go func() {
		defer wg.Done()
		t := time.Now()
		lres, lerr = r.Lexical(ctx, query, vec, kinds, lang, limit, trgmMinSim, trackIDs)
		lt.LexicalMs = time.Since(t).Milliseconds()
	}()
	wg.Wait()
	if verr != nil {
		return nil, lt, fmt.Errorf("vector lane: %w", verr)
	}
	if lerr != nil {
		return nil, lt, fmt.Errorf("lexical lane: %w", lerr)
	}
	type agg struct {
		hit Hit
		rrf float64
	}
	merged := map[int64]*agg{}
	add := func(hits []Hit) {
		for rank, h := range hits {
			a, ok := merged[h.ChunkID]
			if !ok {
				a = &agg{hit: h}
				merged[h.ChunkID] = a
			}
			a.rrf += 1.0 / float64(rrfK+rank+1)
		}
	}
	add(vres)
	add(lres)

	all := make([]*agg, 0, len(merged))
	for _, a := range merged {
		all = append(all, a)
	}
	// Sort by RRF desc; ties broken by cosine desc for determinism.
	for i := 1; i < len(all); i++ {
		for j := i; j > 0 && (all[j].rrf > all[j-1].rrf ||
			(all[j].rrf == all[j-1].rrf && all[j].hit.Score > all[j-1].hit.Score)); j-- {
			all[j], all[j-1] = all[j-1], all[j]
		}
	}
	out := make([]Hit, 0, limit)
	for i, a := range all {
		if i >= limit {
			break
		}
		out = append(out, a.hit)
	}
	return out, lt, nil
}

// Media returns the transcript chunks of a media clip (kind='media') by
// item_id, ordered by start time (chunk id as a stable tiebreaker). lang
// optional. Used by media_get to enrich the clip with a title/transcript.
func (r *Repo) Media(ctx context.Context, itemID, lang string, max int) ([]Hit, error) {
	where := []string{"c.embed_model = $1", "c.kind = 'media'", "c.item_id = $2"}
	args := []any{r.embedName, itemID}
	if lang != "" {
		where = append(where, fmt.Sprintf("c.lang = $%d", len(args)+1))
		args = append(args, lang)
	}
	args = append(args, max)
	limPos := len(args)
	sql := fmt.Sprintf(`
		SELECT %s, 0::float8 AS score
		FROM chunks c
		WHERE %s
		ORDER BY c.start_ms NULLS FIRST, c.id
		LIMIT $%d`,
		selectCols, strings.Join(where, " AND "), limPos)
	rows, err := r.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return scanHits(rows)
}

// Window returns transcript chunks of a track overlapping [lo, hi].
func (r *Repo) Window(ctx context.Context, trackID string, lo, hi int, lang string, max int) ([]Hit, error) {
	where := []string{"c.embed_model = $1", "c.track_id = $2", "c.end_ms >= $3", "c.start_ms <= $4"}
	args := []any{r.embedName, trackID, lo, hi}
	if lang != "" {
		where = append(where, fmt.Sprintf("c.lang = $%d", len(args)+1))
		args = append(args, lang)
	}
	args = append(args, max)
	limPos := len(args)
	sql := fmt.Sprintf(`
		SELECT %s, 0::float8 AS score
		FROM chunks c
		WHERE %s
		ORDER BY c.start_ms
		LIMIT $%d`,
		selectCols, strings.Join(where, " AND "), limPos)
	rows, err := r.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	return scanHits(rows)
}
