// Package sqlitelibrary reads and writes the canonical-corpus database
// (artifacts/library/library.db). Verses, documents and titles come from the
// library import; attributions and media are written through the MCP tools.
package sqlitelibrary

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	// registers the sqlite3 driver with database/sql.
	_ "github.com/mattn/go-sqlite3"

	"github.com/jiva-studio/shruti/catalogdb"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/library"
)

type Repo struct {
	db   *sql.DB
	path string
}

func Open(ctx context.Context, path string) (*Repo, error) {
	dsn := fmt.Sprintf("file:%s?_journal_mode=WAL&_synchronous=NORMAL&_busy_timeout=60000&_foreign_keys=ON", path)
	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, fmt.Errorf("open library: %w", err)
	}
	db.SetMaxOpenConns(4)
	if err := db.PingContext(ctx); err != nil {
		return nil, errors.Join(fmt.Errorf("ping library: %w", err), db.Close())
	}
	if err := catalogdb.MigrateLibrary(ctx, db); err != nil {
		return nil, errors.Join(err, db.Close())
	}
	return &Repo{db: db, path: path}, nil
}

func (r *Repo) Close() error { return r.db.Close() }
func (r *Repo) Path() string { return r.path }

// ---------- VERSE ----------

func (r *Repo) GetVerse(ctx context.Context, sourceID, tokens string) (library.Verse, bool, error) {
	v, ok, err := catalogdb.VerseAt(ctx, r.db, sourceID, tokens)
	if err != nil || !ok {
		return library.Verse{}, false, err
	}
	return r.withTranslations(ctx, v)
}

func (r *Repo) GetVerseByID(ctx context.Context, id string) (library.Verse, bool, error) {
	v, ok, err := catalogdb.VerseByID(ctx, r.db, id)
	if err != nil || !ok {
		return library.Verse{}, false, err
	}
	return r.withTranslations(ctx, v)
}

func (r *Repo) withTranslations(ctx context.Context, v catalogdb.Verse) (library.Verse, bool, error) {
	tr, err := catalogdb.CanonicalTranslationsOf(ctx, r.db, []string{v.ID})
	if err != nil {
		return library.Verse{}, false, err
	}
	return toVerse(v, tr[v.ID], ""), true, nil
}

// toVerse maps a stored verse and its canonical translations; a non-empty
// lang keeps only that language.
func toVerse(v catalogdb.Verse, translations map[string]string, lang string) library.Verse {
	out := library.Verse{
		ID:              v.ID,
		SourceID:        v.SourceID,
		Tokens:          v.Tokens,
		Text:            v.Text,
		Transliteration: v.Transliteration,
		Translations:    map[string]string{},
	}
	for l, tr := range translations {
		if lang == "" || l == lang {
			out.Translations[l] = tr
		}
	}
	return out
}

// ListVerses pages through a source's verses in token order. A requested
// language keeps only that translation, to keep the response slim.
func (r *Repo) ListVerses(ctx context.Context, opts library.ListVersesOpts) ([]library.Verse, error) {
	if opts.SourceID == "" {
		return nil, fmt.Errorf("source_id is required")
	}
	limit := opts.Limit
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	var args []any
	q := `SELECT id, tokens, text, transliteration FROM library_verses WHERE source_id = ?`
	args = append(args, opts.SourceID)
	if opts.TokenPrefix != "" {
		q += ` AND tokens LIKE ? ESCAPE '\'`
		args = append(args, escapeLikePrefix(opts.TokenPrefix))
	}
	if opts.Cursor != "" {
		q += ` AND tokens > ?`
		args = append(args, opts.Cursor)
	}
	q += ` ORDER BY tokens LIMIT ?`
	args = append(args, limit)

	verses, err := r.verseRows(ctx, opts.SourceID, q, args...)
	if err != nil {
		return nil, err
	}
	ids := make([]string, len(verses))
	for i, v := range verses {
		ids[i] = v.ID
	}
	translations, err := catalogdb.CanonicalTranslationsOf(ctx, r.db, ids)
	if err != nil {
		return nil, err
	}
	out := make([]library.Verse, len(verses))
	for i, v := range verses {
		out[i] = toVerse(v, translations[v.ID], opts.Language)
	}
	return out, nil
}

func (r *Repo) verseRows(ctx context.Context, sourceID, q string, args ...any) ([]catalogdb.Verse, error) {
	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []catalogdb.Verse
	for rows.Next() {
		v := catalogdb.Verse{SourceID: sourceID}
		var text, translit sql.NullString
		if err := rows.Scan(&v.ID, &v.Tokens, &text, &translit); err != nil {
			return nil, err
		}
		v.Text, v.Transliteration = text.String, translit.String
		out = append(out, v)
	}
	return out, rows.Err()
}

// ---------- DOCUMENT ----------

func (r *Repo) GetDocument(ctx context.Context, id string) (library.Document, bool, error) {
	row := r.db.QueryRowContext(ctx,
		`SELECT id, source_id, tokens, author_id, kind, COALESCE(date,'') FROM library_documents WHERE id = ?`,
		id,
	)
	var d library.Document
	var kind string
	if err := row.Scan(&d.ID, &d.SourceID, &d.Tokens, &d.AuthorID, &kind, &d.Date); err != nil {
		if err == sql.ErrNoRows {
			return library.Document{}, false, nil
		}
		return library.Document{}, false, err
	}
	d.Kind = library.DocumentKind(kind)
	bodies, err := r.readDocumentBodies(ctx, d.ID, "")
	if err != nil {
		return library.Document{}, false, err
	}
	d.Bodies = bodies
	return d, true, nil
}

func (r *Repo) readDocumentBodies(ctx context.Context, docID, lang string) (map[string]library.DocumentBody, error) {
	q := `SELECT language, COALESCE(title,''), body FROM library_document_variants WHERE document_id = ?`
	args := []any{docID}
	if lang != "" {
		q += ` AND language = ?`
		args = append(args, lang)
	}
	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]library.DocumentBody)
	for rows.Next() {
		var l, t, b string
		if err := rows.Scan(&l, &t, &b); err != nil {
			return nil, err
		}
		out[l] = library.DocumentBody{Title: t, Body: b}
	}
	return out, rows.Err()
}

func (r *Repo) ListDocuments(ctx context.Context, opts library.ListDocumentsOpts) ([]library.Document, error) {
	limit := opts.Limit
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	q := `SELECT id, source_id, tokens, author_id, kind, COALESCE(date,'') FROM library_documents WHERE 1=1`
	var args []any
	if opts.SourceID != "" {
		q += ` AND source_id = ?`
		args = append(args, opts.SourceID)
	}
	if opts.Kind != "" {
		q += ` AND kind = ?`
		args = append(args, string(opts.Kind))
	}
	if opts.AuthorID != "" {
		q += ` AND author_id = ?`
		args = append(args, opts.AuthorID)
	}
	if opts.TokenPrefix != "" {
		q += ` AND tokens LIKE ? ESCAPE '\'`
		args = append(args, escapeLikePrefix(opts.TokenPrefix))
	}
	if opts.Cursor != "" {
		q += ` AND id > ?`
		args = append(args, opts.Cursor)
	}
	q += ` ORDER BY id LIMIT ?`
	args = append(args, limit)

	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var docs []library.Document
	for rows.Next() {
		var d library.Document
		var kind string
		if err := rows.Scan(&d.ID, &d.SourceID, &d.Tokens, &d.AuthorID, &kind, &d.Date); err != nil {
			return nil, err
		}
		d.Kind = library.DocumentKind(kind)
		docs = append(docs, d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range docs {
		b, err := r.readDocumentBodies(ctx, docs[i].ID, opts.Language)
		if err != nil {
			return nil, err
		}
		docs[i].Bodies = b
	}
	return docs, nil
}

// ---------- TITLE ----------

func (r *Repo) GetTitle(ctx context.Context, sourceID, tokens, language string) (string, bool, error) {
	row := r.db.QueryRowContext(ctx,
		`SELECT title FROM library_titles WHERE source_id = ? AND tokens = ? AND language = ?`,
		sourceID, tokens, language,
	)
	var t string
	if err := row.Scan(&t); err != nil {
		if err == sql.ErrNoRows {
			return "", false, nil
		}
		return "", false, err
	}
	return t, true, nil
}

func (r *Repo) ListTitles(ctx context.Context, opts library.ListTitlesOpts) ([]library.Title, error) {
	limit := opts.Limit
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	q := `SELECT source_id, tokens, language, title FROM library_titles WHERE 1=1`
	var args []any
	if opts.SourceID != "" {
		q += ` AND source_id = ?`
		args = append(args, opts.SourceID)
	}
	if opts.Language != "" {
		q += ` AND language = ?`
		args = append(args, opts.Language)
	}
	if opts.TokenPrefix != "" {
		q += ` AND tokens LIKE ? ESCAPE '\'`
		args = append(args, escapeLikePrefix(opts.TokenPrefix))
	}
	q += ` ORDER BY source_id, tokens, language LIMIT ?`
	args = append(args, limit)
	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []library.Title
	for rows.Next() {
		var t library.Title
		if err := rows.Scan(&t.SourceID, &t.Tokens, &t.Language, &t.Title); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// ---------- helpers ----------

// escapeLikePrefix appends '%' for a prefix-match LIKE and escapes any
// glob characters in the prefix itself.
func escapeLikePrefix(prefix string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(prefix) + "%"
}
