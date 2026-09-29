package library

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"github.com/jiva-studio/shruti/catalogdb"
	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/refs"
)

// ── Documents ──────────────────────────────────────────────────────────────

// DocBody is the localized title+body of a document.
type DocBody struct {
	Title string `json:"title"`
	Body  string `json:"body"`
}

// Document is a commentary / prose_chapter / letter.
type Document struct {
	ID       string
	SourceID string
	Tokens   string
	AuthorID string
	Kind     string
	Date     string
	Bodies   map[string]DocBody // lang -> body
}

const documentColumns = `id, source_id, tokens, author_id, kind, date`

func scanDocument(scan func(dest ...any) error) (*Document, error) {
	var d Document
	var date sql.NullString
	if err := scan(&d.ID, &d.SourceID, &d.Tokens, &d.AuthorID, &d.Kind, &date); err != nil {
		return nil, err
	}
	d.Date = date.String
	d.Bodies = map[string]DocBody{}
	return &d, nil
}

// loadBodies fills the localized bodies of every document with one query.
func loadBodies(ctx context.Context, q catalogdb.Querier, docs []*Document) error {
	if len(docs) == 0 {
		return nil
	}
	byID := make(map[string]*Document, len(docs))
	args := make([]any, len(docs))
	for i, d := range docs {
		byID[d.ID] = d
		args[i] = d.ID
	}
	rows, err := q.QueryContext(ctx,
		`SELECT document_id, language, title, body FROM library_document_variants
		 WHERE document_id IN (`+strings.TrimSuffix(strings.Repeat("?,", len(docs)), ",")+`)`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id, lang, body string
		var title sql.NullString
		if err := rows.Scan(&id, &lang, &title, &body); err != nil {
			return err
		}
		if d, ok := byID[id]; ok {
			d.Bodies[lang] = DocBody{Title: title.String, Body: body}
		}
	}
	return rows.Err()
}

// GetDocument returns a document by id, or (nil,nil) if absent.
func (r *Repo) GetDocument(ctx context.Context, id string) (*Document, error) {
	var doc *Document
	err := r.read(func(q catalogdb.Querier) error {
		d, err := scanDocument(q.QueryRowContext(ctx,
			`SELECT `+documentColumns+` FROM library_documents WHERE id = ?`, id).Scan)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		doc = d
		return loadBodies(ctx, q, []*Document{d})
	})
	return doc, err
}

// DocFilter narrows ListDocuments.
type DocFilter struct {
	SourceID string
	Tokens   string
	Kind     string
	AuthorID string
	CursorID string
	Limit    int
}

// ListDocuments returns documents at a reference / in a book, ordered by id,
// paginated by the last document id.
func (r *Repo) ListDocuments(ctx context.Context, f DocFilter) ([]*Document, error) {
	where := []string{"source_id = ?"}
	args := []any{f.SourceID}
	if f.Tokens != "" {
		where = append(where, "tokens = ?")
		args = append(args, f.Tokens)
	}
	if f.Kind != "" {
		where = append(where, "kind = ?")
		args = append(args, f.Kind)
	}
	if f.AuthorID != "" {
		where = append(where, "author_id = ?")
		args = append(args, f.AuthorID)
	}
	if f.CursorID != "" {
		where = append(where, "id > ?")
		args = append(args, f.CursorID)
	}
	query := `SELECT ` + documentColumns + ` FROM library_documents WHERE ` +
		strings.Join(where, " AND ") + ` ORDER BY id LIMIT ?`
	args = append(args, f.Limit)

	var out []*Document
	err := r.read(func(q catalogdb.Querier) error {
		rows, err := q.QueryContext(ctx, query, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			d, err := scanDocument(rows.Scan)
			if err != nil {
				return err
			}
			out = append(out, d)
		}
		if err := rows.Err(); err != nil {
			return err
		}
		return loadBodies(ctx, q, out)
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// ── Source stats ───────────────────────────────────────────────────────────

// SourceStats holds the derived per-source fields for source_get / source_list.
type SourceStats struct {
	TokenScheme   string
	VerseCount    int
	HasCommentary bool
}

// Stats computes token scheme, verse count and has-commentary for a source_id.
func (r *Repo) Stats(ctx context.Context, sourceID string) (SourceStats, error) {
	var st SourceStats
	err := r.read(func(q catalogdb.Querier) error {
		depth, err := maxDepth(ctx, q, sourceID)
		if err != nil {
			return err
		}
		st.TokenScheme = refs.Scheme(depth)
		if st.VerseCount, err = countVerses(ctx, q, sourceID); err != nil {
			return err
		}
		var one int
		err = q.QueryRowContext(ctx,
			`SELECT 1 FROM library_documents WHERE source_id = ? AND kind = 'commentary' LIMIT 1`, sourceID).
			Scan(&one)
		switch {
		case err == nil:
			st.HasCommentary = true
		case !errors.Is(err, sql.ErrNoRows):
			return err
		}
		return nil
	})
	return st, err
}

// maxDepth returns the deepest token component count across verses+documents.
func maxDepth(ctx context.Context, q catalogdb.Querier, sourceID string) (int, error) {
	const dotExpr = `MAX(length(tokens) - length(replace(tokens, '.', '')))`
	best := -1
	for _, tbl := range []string{"library_verses", "library_documents"} {
		var dots sql.NullInt64
		err := q.QueryRowContext(ctx,
			`SELECT `+dotExpr+` FROM `+tbl+` WHERE source_id = ?`, sourceID).Scan(&dots)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return 0, err
		}
		if dots.Valid && int(dots.Int64) > best {
			best = int(dots.Int64)
		}
	}
	if best < 0 {
		return 0, nil
	}
	return best + 1, nil
}

// countVerses counts verses by token row, excluding ".0" chapter summaries.
// This is the traditional per-token count (a merged verse like BG 1.16-18
// counts as its 3 member rows) — unlike verse_list, which collapses merged
// runs for display.
func countVerses(ctx context.Context, q catalogdb.Querier, sourceID string) (int, error) {
	rows, err := q.QueryContext(ctx, `SELECT tokens FROM library_verses WHERE source_id = ?`, sourceID)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var tok string
		if err := rows.Scan(&tok); err != nil {
			return 0, err
		}
		if !refs.IsChapterSummary(tok) {
			count++
		}
	}
	return count, rows.Err()
}
