package catalogdb

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// Verse is one row of `library_verses`: the original script and the stored
// IAST transliteration, both verbatim and possibly empty.
type Verse struct {
	ID              string
	SourceID        string
	Tokens          string
	Text            string
	Transliteration string
}

const verseColumns = `id, source_id, tokens, text, transliteration`

// VerseByID returns a verse by id, and false when there is none.
func VerseByID(ctx context.Context, q Querier, id string) (Verse, bool, error) {
	return verseRow(ctx, q, `SELECT `+verseColumns+` FROM library_verses WHERE id = ?`, id)
}

// VerseAt returns the verse at (source, tokens), and false when there is none.
func VerseAt(ctx context.Context, q Querier, sourceID, tokens string) (Verse, bool, error) {
	return verseRow(ctx, q,
		`SELECT `+verseColumns+` FROM library_verses WHERE source_id = ? AND tokens = ?`, sourceID, tokens)
}

func verseRow(ctx context.Context, q Querier, query string, args ...any) (Verse, bool, error) {
	var (
		v        Verse
		text, tr sql.NullString
	)
	err := q.QueryRowContext(ctx, query, args...).Scan(&v.ID, &v.SourceID, &v.Tokens, &text, &tr)
	if errors.Is(err, sql.ErrNoRows) {
		return Verse{}, false, nil
	}
	if err != nil {
		return Verse{}, false, fmt.Errorf("read verse: %w", err)
	}
	v.Text, v.Transliteration = text.String, tr.String
	return v, true, nil
}

// VersesOf returns the verses of a source in storage order, optionally only
// those under a position prefix ("2" returns 2.1, 2.2, …).
func VersesOf(ctx context.Context, q Querier, sourceID, prefix string) ([]Verse, error) {
	query := `SELECT ` + verseColumns + ` FROM library_verses WHERE source_id = ?`
	args := []any{sourceID}
	if prefix != "" {
		query += ` AND tokens LIKE ?`
		args = append(args, prefix+".%")
	}
	return verseRows(ctx, q, query, args...)
}

// VersesWithText returns the verses of a source that hold exactly this text.
// A merged verse is stored as one row per member position, each with the
// same block, so this finds the whole merge.
func VersesWithText(ctx context.Context, q Querier, sourceID, text string) ([]Verse, error) {
	return verseRows(ctx, q,
		`SELECT `+verseColumns+` FROM library_verses WHERE source_id = ? AND text = ?`, sourceID, text)
}

func verseRows(ctx context.Context, q Querier, query string, args ...any) ([]Verse, error) {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("read verses: %w", err)
	}
	defer rows.Close()
	var out []Verse
	for rows.Next() {
		var (
			v        Verse
			text, tr sql.NullString
		)
		if err := rows.Scan(&v.ID, &v.SourceID, &v.Tokens, &text, &tr); err != nil {
			return nil, fmt.Errorf("scan verse: %w", err)
		}
		v.Text, v.Transliteration = text.String, tr.String
		out = append(out, v)
	}
	return out, rows.Err()
}

// CanonicalTranslationsOf returns each verse's canonical translation per
// language.
func CanonicalTranslationsOf(ctx context.Context, q Querier, verseIDs []string) (map[string]map[string]string, error) {
	out := map[string]map[string]string{}
	err := eachChunk(verseIDs, func(ids []string, ph string) error {
		rows, err := q.QueryContext(ctx,
			`SELECT verse_id, language, translation FROM library_verse_translations
			 WHERE kind = 'canonical' AND verse_id IN (`+ph+`)`, anySlice(ids)...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id, lang, tr string
			if err := rows.Scan(&id, &lang, &tr); err != nil {
				return err
			}
			if out[id] == nil {
				out[id] = map[string]string{}
			}
			out[id][lang] = tr
		}
		return rows.Err()
	})
	if err != nil {
		return nil, fmt.Errorf("read canonical translations: %w", err)
	}
	return out, nil
}

// Translation is one translation of a verse in one language. Kind is its
// address among the translations of that language; "canonical" is the
// default.
type Translation struct {
	Kind     string
	AuthorID string
	Note     string
	Text     string
}

// TranslationsOf returns every translation of a verse in a language,
// canonical first, then by kind.
func TranslationsOf(ctx context.Context, q Querier, verseID, lang string) ([]Translation, error) {
	rows, err := q.QueryContext(ctx,
		`SELECT kind, COALESCE(author_id, ''), COALESCE(note, ''), translation
		 FROM library_verse_translations
		 WHERE verse_id = ? AND language = ?
		 ORDER BY (kind = 'canonical') DESC, kind`, verseID, lang)
	if err != nil {
		return nil, fmt.Errorf("read translations of %s: %w", verseID, err)
	}
	defer rows.Close()
	var out []Translation
	for rows.Next() {
		var t Translation
		if err := rows.Scan(&t.Kind, &t.AuthorID, &t.Note, &t.Text); err != nil {
			return nil, fmt.Errorf("scan translation of %s: %w", verseID, err)
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// TranslationOf returns one translation of a verse, and false when there is
// none of that kind in that language.
func TranslationOf(ctx context.Context, q Querier, verseID, lang, kind string) (Translation, bool, error) {
	var (
		t            Translation
		author, note sql.NullString
	)
	err := q.QueryRowContext(ctx,
		`SELECT kind, author_id, note, translation FROM library_verse_translations
		 WHERE verse_id = ? AND language = ? AND kind = ?`, verseID, lang, kind).
		Scan(&t.Kind, &author, &note, &t.Text)
	if errors.Is(err, sql.ErrNoRows) {
		return Translation{}, false, nil
	}
	if err != nil {
		return Translation{}, false, fmt.Errorf("read translation of %s: %w", verseID, err)
	}
	t.AuthorID, t.Note = author.String, note.String
	return t, true, nil
}

// TransliterationOf returns the verse transliterated into a language's script,
// and false when that language has none stored.
func TransliterationOf(ctx context.Context, q Querier, verseID, lang string) (string, bool, error) {
	var text string
	err := q.QueryRowContext(ctx,
		`SELECT text FROM library_verse_transliterations WHERE verse_id = ? AND language = ?`,
		verseID, lang).Scan(&text)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("read transliteration of %s: %w", verseID, err)
	}
	return text, text != "", nil
}

// Word is one gloss of a verse's word-by-word breakdown.
type Word struct {
	Surface string
	Gloss   string
}

// WordsOf returns the word-by-word breakdown of one translation, in order.
func WordsOf(ctx context.Context, q Querier, verseID, lang, kind string) ([]Word, error) {
	rows, err := q.QueryContext(ctx,
		`SELECT w.surface_form, w.surface_translation
		 FROM library_verse_translations t
		 JOIN library_verse_words w ON w.translation_id = t.id
		 WHERE t.verse_id = ? AND t.language = ? AND t.kind = ?
		 ORDER BY w.sort_order`, verseID, lang, kind)
	if err != nil {
		return nil, fmt.Errorf("read words of %s: %w", verseID, err)
	}
	defer rows.Close()
	var out []Word
	for rows.Next() {
		var w Word
		if err := rows.Scan(&w.Surface, &w.Gloss); err != nil {
			return nil, fmt.Errorf("scan word of %s: %w", verseID, err)
		}
		out = append(out, w)
	}
	return out, rows.Err()
}

// Attribution is one curated attribution with its phrases, notes and
// references.
type Attribution struct {
	ID        string
	Kind      string
	CreatedAt string
	UpdatedAt string
	// Triggers are the search phrases per language, sorted.
	Triggers map[string][]string
	// Notes is the curator note per language (memory attributions only).
	Notes map[string]string
	Refs  []AttributionRef
}

// AttributionRef is one reference of an attribution. TargetID is a verse or
// document id, a TitleTarget or a TrackTarget, as Kind says. An empty
// Language means the reference holds in every language.
type AttributionRef struct {
	Kind     string
	TargetID string
	Language string
	Position int
}

// AttributionByID returns an attribution with everything it holds, and false
// when there is none.
func AttributionByID(ctx context.Context, q Querier, id string) (Attribution, bool, error) {
	var a Attribution
	err := q.QueryRowContext(ctx,
		`SELECT id, kind, created_at, updated_at FROM library_attributions WHERE id = ?`, id).
		Scan(&a.ID, &a.Kind, &a.CreatedAt, &a.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Attribution{}, false, nil
	}
	if err != nil {
		return Attribution{}, false, fmt.Errorf("read attribution %s: %w", id, err)
	}
	if a.Triggers, err = attributionTriggers(ctx, q, id); err != nil {
		return Attribution{}, false, err
	}
	if a.Notes, err = attributionNotes(ctx, q, id); err != nil {
		return Attribution{}, false, err
	}
	if a.Refs, err = attributionRefs(ctx, q, id); err != nil {
		return Attribution{}, false, err
	}
	return a, true, nil
}

func attributionTriggers(ctx context.Context, q Querier, id string) (map[string][]string, error) {
	rows, err := q.QueryContext(ctx,
		`SELECT language, text FROM library_attribution_triggers
		 WHERE attribution_id = ? ORDER BY language, text`, id)
	if err != nil {
		return nil, fmt.Errorf("read triggers of %s: %w", id, err)
	}
	defer rows.Close()
	out := map[string][]string{}
	for rows.Next() {
		var lang, text string
		if err := rows.Scan(&lang, &text); err != nil {
			return nil, fmt.Errorf("scan trigger of %s: %w", id, err)
		}
		out[lang] = append(out[lang], text)
	}
	return out, rows.Err()
}

func attributionNotes(ctx context.Context, q Querier, id string) (map[string]string, error) {
	rows, err := q.QueryContext(ctx,
		`SELECT language, note FROM library_attribution_notes WHERE attribution_id = ? ORDER BY language`, id)
	if err != nil {
		return nil, fmt.Errorf("read notes of %s: %w", id, err)
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var lang, note string
		if err := rows.Scan(&lang, &note); err != nil {
			return nil, fmt.Errorf("scan note of %s: %w", id, err)
		}
		out[lang] = note
	}
	return out, rows.Err()
}

func attributionRefs(ctx context.Context, q Querier, id string) ([]AttributionRef, error) {
	rows, err := q.QueryContext(ctx,
		`SELECT ref_kind, target_id, language, position FROM library_attribution_refs
		 WHERE attribution_id = ? ORDER BY position, ref_kind, target_id`, id)
	if err != nil {
		return nil, fmt.Errorf("read refs of %s: %w", id, err)
	}
	defer rows.Close()
	var out []AttributionRef
	for rows.Next() {
		var (
			r    AttributionRef
			lang sql.NullString
		)
		if err := rows.Scan(&r.Kind, &r.TargetID, &lang, &r.Position); err != nil {
			return nil, fmt.Errorf("scan ref of %s: %w", id, err)
		}
		r.Language = lang.String
		out = append(out, r)
	}
	return out, rows.Err()
}
