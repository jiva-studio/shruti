// Package library reads the library SQLite (library.db): structured verses
// (original script + stored IAST transliteration + per-language translations),
// documents (commentary / prose_chapter / letter), and derived per-source
// stats (token scheme, verse count, has-commentary).
//
// Data rules (verified against the live library.db):
//   - ".0" tokens are chapter summaries, not verses — skipped by ListVerses.
//   - A merged verse (e.g. BG 1.16-18) is stored as one row per member token,
//     each holding the identical block; ListVerses collapses the run into a
//     single item carrying a `covers` span.
package library

import (
	"context"
	"database/sql"
	"sort"
	"strings"

	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/refs"
	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/sqlitedb"
)

type Repo struct{ h *sqlitedb.Handle }

func New(h *sqlitedb.Handle) *Repo { return &Repo{h: h} }

func (r *Repo) db() *sql.DB { return r.h.DB() }

// ── Verses ─────────────────────────────────────────────────────────────────

// Verse is a full verse record.
type Verse struct {
	ID              string
	SourceID        string
	Tokens          string
	Text            string            // original (Devanagari / Bengali), verbatim
	Transliteration string            // stored IAST, verbatim (may be "")
	Translations    map[string]string // lang -> translation
}

func (r *Repo) loadTranslations(ctx context.Context, verseID string) (map[string]string, error) {
	rows, err := r.db().QueryContext(ctx,
		`SELECT language, translation FROM library_verse_variants WHERE verse_id = ?`, verseID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var lang, tr string
		if err := rows.Scan(&lang, &tr); err != nil {
			return nil, err
		}
		out[lang] = tr
	}
	return out, rows.Err()
}

// GetByID returns a verse by its verse_id, or (nil,nil) if absent.
func (r *Repo) GetByID(ctx context.Context, id string) (*Verse, error) {
	return r.getVerse(ctx, `SELECT id, source_id, tokens, text, transliteration FROM library_verses WHERE id = ?`, id)
}

// GetByRef returns a verse by (source_id, tokens), or (nil,nil) if absent.
func (r *Repo) GetByRef(ctx context.Context, sourceID, tokens string) (*Verse, error) {
	return r.getVerse(ctx,
		`SELECT id, source_id, tokens, text, transliteration FROM library_verses WHERE source_id = ? AND tokens = ?`,
		sourceID, tokens)
}

func (r *Repo) getVerse(ctx context.Context, q string, args ...any) (*Verse, error) {
	var v Verse
	var text, tr sql.NullString
	err := r.db().QueryRowContext(ctx, q, args...).Scan(&v.ID, &v.SourceID, &v.Tokens, &text, &tr)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	v.Text = text.String
	v.Transliteration = tr.String
	trs, err := r.loadTranslations(ctx, v.ID)
	if err != nil {
		return nil, err
	}
	v.Translations = trs
	return &v, nil
}

// VerseCovers returns the merged-verse span a verse belongs to, e.g.
// ── Translations & word-by-word ──────────────────────────────────────────────

// TranslationMeta describes an available translation of a verse in one language
// without its text (kind is the addressing key; canonical is the default).
type TranslationMeta struct {
	Kind     string
	AuthorID string
	Note     string
}

// Translation is one translation record with its full text.
type Translation struct {
	Kind     string
	AuthorID string
	Note     string
	Text     string
}

// Word is one pada gloss within a verse's word-by-word breakdown.
type Word struct {
	Surface string
	Gloss   string
}

// TranslationMetas returns every translation variant of a verse in `lang` as
// metadata (no text), canonical first. Reads library_verse_translations
// directly (the compat view exposes only the canonical text).
func (r *Repo) TranslationMetas(ctx context.Context, verseID, lang string) ([]TranslationMeta, error) {
	rows, err := r.db().QueryContext(ctx,
		`SELECT kind, COALESCE(author_id,''), COALESCE(note,'')
		   FROM library_verse_translations
		  WHERE verse_id = ? AND language = ?
		  ORDER BY (kind='canonical') DESC, kind`, verseID, lang)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []TranslationMeta
	for rows.Next() {
		var m TranslationMeta
		if err := rows.Scan(&m.Kind, &m.AuthorID, &m.Note); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// GetTranslation returns one translation (verse, lang, kind), or (nil,nil) if absent.
func (r *Repo) GetTranslation(ctx context.Context, verseID, lang, kind string) (*Translation, error) {
	var t Translation
	var author, note sql.NullString
	err := r.db().QueryRowContext(ctx,
		`SELECT kind, author_id, note, translation
		   FROM library_verse_translations
		  WHERE verse_id = ? AND language = ? AND kind = ?`, verseID, lang, kind).
		Scan(&t.Kind, &author, &note, &t.Text)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	t.AuthorID = author.String
	t.Note = note.String
	return &t, nil
}

// Transliteration returns the verse transliteration in `lang`'s script from
// library_verse_transliterations (materialised at import for ru/uk/sr-Cyrl and
// the Latin IAST for en/sr-Latn). Falls back to iastFallback (the raw IAST in
// library_verses.transliteration) for any language not stored — the app's other
// locales (pl, de, …) — or when the table predates this feature.
func (r *Repo) Transliteration(ctx context.Context, verseID, lang, iastFallback string) string {
	if lang == "" {
		return iastFallback
	}
	var text string
	err := r.db().QueryRowContext(ctx,
		`SELECT text FROM library_verse_transliterations WHERE verse_id = ? AND language = ?`,
		verseID, lang).Scan(&text)
	if err != nil || text == "" {
		return iastFallback
	}
	return text
}

// Words returns the word-by-word breakdown for (verse, lang, kind), ordered.
func (r *Repo) Words(ctx context.Context, verseID, lang, kind string) ([]Word, error) {
	rows, err := r.db().QueryContext(ctx,
		`SELECT w.surface_form, w.surface_translation
		   FROM library_verse_translations t
		   JOIN library_verse_words w ON w.translation_id = t.id
		  WHERE t.verse_id = ? AND t.language = ? AND t.kind = ?
		  ORDER BY w.sort_order`, verseID, lang, kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Word
	for rows.Next() {
		var w Word
		if err := rows.Scan(&w.Surface, &w.Gloss); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

// "1.16-1.18", or "" for a normal (non-merged) verse. A merged verse is stored
// as one row per member token, each holding the identical text; this uses the
// same rule ListVerses uses to collapse such runs (a contiguous run of rows in
// the same source sharing the same non-empty text). Empty-text rows (chapter
// summaries) never merge.
func (r *Repo) VerseCovers(ctx context.Context, v *Verse) (string, error) {
	if v == nil || v.Text == "" {
		return "", nil
	}
	rows, err := r.db().QueryContext(ctx,
		`SELECT tokens FROM library_verses WHERE source_id = ? AND text = ?`,
		v.SourceID, v.Text)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	var toks []string
	for rows.Next() {
		var tok string
		if err := rows.Scan(&tok); err != nil {
			return "", err
		}
		toks = append(toks, tok)
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	if len(toks) < 2 {
		return "", nil
	}
	sort.Slice(toks, func(i, j int) bool { return refs.CompareTokens(toks[i], toks[j]) < 0 })
	return toks[0] + "-" + toks[len(toks)-1], nil
}

// VerseListItem is one entry from ListVerses (merged rows collapsed).
type VerseListItem struct {
	ID           string
	SourceID     string
	Tokens       string            // first member token
	Covers       string            // "1.16-1.18" for a merged run, else ""
	Translations map[string]string // lang -> translation (for preview)
}

type verseRow struct {
	id     string
	tokens string
	text   string
}

// ListVerses returns the verses of a source (optionally restricted to a
// chapter/canto prefix), numerically ordered, with ".0" summaries skipped and
// merged runs collapsed.
func (r *Repo) ListVerses(ctx context.Context, sourceID, prefix string) ([]VerseListItem, error) {
	q := `SELECT id, tokens, text FROM library_verses WHERE source_id = ?`
	args := []any{sourceID}
	if prefix != "" {
		q += ` AND tokens LIKE ?`
		args = append(args, prefix+".%")
	}
	rows, err := r.db().QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var all []verseRow
	for rows.Next() {
		var vr verseRow
		var text sql.NullString
		if err := rows.Scan(&vr.id, &vr.tokens, &text); err != nil {
			return nil, err
		}
		vr.text = text.String
		all = append(all, vr)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.Slice(all, func(i, j int) bool { return refs.CompareTokens(all[i].tokens, all[j].tokens) < 0 })

	var items []VerseListItem
	i := 0
	for i < len(all) {
		vr := all[i]
		if refs.IsChapterSummary(vr.tokens) {
			i++
			continue
		}
		// Collapse a merged run: consecutive rows with the same non-empty text.
		j := i + 1
		if vr.text != "" {
			for j < len(all) && all[j].text == vr.text && !refs.IsChapterSummary(all[j].tokens) {
				j++
			}
		}
		item := VerseListItem{ID: vr.id, SourceID: sourceID, Tokens: vr.tokens}
		if j-i > 1 {
			item.Covers = vr.tokens + "-" + all[j-1].tokens
		}
		trs, err := r.loadTranslations(ctx, vr.id)
		if err != nil {
			return nil, err
		}
		item.Translations = trs
		items = append(items, item)
		i = j
	}
	return items, nil
}

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

func (r *Repo) loadBodies(ctx context.Context, docID string) (map[string]DocBody, error) {
	rows, err := r.db().QueryContext(ctx,
		`SELECT language, title, body FROM library_document_variants WHERE document_id = ?`, docID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]DocBody{}
	for rows.Next() {
		var lang, body string
		var title sql.NullString
		if err := rows.Scan(&lang, &title, &body); err != nil {
			return nil, err
		}
		out[lang] = DocBody{Title: title.String, Body: body}
	}
	return out, rows.Err()
}

// GetDocument returns a document by id, or (nil,nil) if absent.
func (r *Repo) GetDocument(ctx context.Context, id string) (*Document, error) {
	var d Document
	var date sql.NullString
	err := r.db().QueryRowContext(ctx,
		`SELECT id, source_id, tokens, author_id, kind, date FROM library_documents WHERE id = ?`, id).
		Scan(&d.ID, &d.SourceID, &d.Tokens, &d.AuthorID, &d.Kind, &date)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	d.Date = date.String
	bodies, err := r.loadBodies(ctx, d.ID)
	if err != nil {
		return nil, err
	}
	d.Bodies = bodies
	return &d, nil
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

// ListDocuments returns documents at a reference / in a book, ordered by
// (tokens, id), paginated by the last document id.
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
	q := `SELECT id, source_id, tokens, author_id, kind, date FROM library_documents WHERE ` +
		strings.Join(where, " AND ") + ` ORDER BY id LIMIT ?`
	args = append(args, f.Limit)

	rows, err := r.db().QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Document
	for rows.Next() {
		var d Document
		var date sql.NullString
		if err := rows.Scan(&d.ID, &d.SourceID, &d.Tokens, &d.AuthorID, &d.Kind, &date); err != nil {
			return nil, err
		}
		d.Date = date.String
		out = append(out, &d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, d := range out {
		bodies, err := r.loadBodies(ctx, d.ID)
		if err != nil {
			return nil, err
		}
		d.Bodies = bodies
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
	depth, err := r.maxDepth(ctx, sourceID)
	if err != nil {
		return st, err
	}
	st.TokenScheme = refs.Scheme(depth)

	vc, err := r.countVerses(ctx, sourceID)
	if err != nil {
		return st, err
	}
	st.VerseCount = vc

	var one int
	err = r.db().QueryRowContext(ctx,
		`SELECT 1 FROM library_documents WHERE source_id = ? AND kind = 'commentary' LIMIT 1`, sourceID).
		Scan(&one)
	if err == nil {
		st.HasCommentary = true
	} else if err != sql.ErrNoRows {
		return st, err
	}
	return st, nil
}

// maxDepth returns the deepest token component count across verses+documents.
func (r *Repo) maxDepth(ctx context.Context, sourceID string) (int, error) {
	const dotExpr = `MAX(length(tokens) - length(replace(tokens, '.', '')))`
	best := -1
	for _, tbl := range []string{"library_verses", "library_documents"} {
		var dots sql.NullInt64
		err := r.db().QueryRowContext(ctx,
			`SELECT `+dotExpr+` FROM `+tbl+` WHERE source_id = ?`, sourceID).Scan(&dots)
		if err != nil && err != sql.ErrNoRows {
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
func (r *Repo) countVerses(ctx context.Context, sourceID string) (int, error) {
	rows, err := r.db().QueryContext(ctx,
		`SELECT tokens FROM library_verses WHERE source_id = ?`, sourceID)
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
