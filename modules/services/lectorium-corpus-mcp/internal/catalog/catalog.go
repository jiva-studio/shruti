// Package catalog reads the catalog SQLite (current.db): the source / author /
// location dictionaries (used to turn a name into an id and to resolve a
// reference book code into a source_id), plus per-track metadata, tags and the
// track_references table.
//
// Schema surprise (verified against the live current.db): there is NO
// first-class track "kind" column. The API's lecture|conversation subtype is
// DERIVED here from a track's tags (see convTags) — conversation-like tags
// (morning walk, conversation, interview, press conference) => "conversation",
// otherwise "lecture".
package catalog

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/jiva-studio/lectorium/modules/services/lectorium-corpus-mcp/internal/sqlitedb"
)

// convTags are the tag ids that make a track a "conversation" rather than a
// "lecture" (the two subtype values the API exposes).
var convTags = map[string]bool{
	"tag_morning_walk": true,
	"tag_conversation": true,
	"tag_interview":    true,
	"tag_press_conf":   true,
}

func convTagList() []string {
	out := make([]string, 0, len(convTags))
	for t := range convTags {
		out = append(out, t)
	}
	return out
}

// crossAlias maps a book code typed in one script to the equivalent stored
// short_name in the other (spec §5). Stored short_names already carry both
// languages, so this is a fallback for codes typed in the "other" script.
var crossAlias = map[string]string{
	"бг": "bg", "bg": "бг",
	"шб": "sb", "sb": "шб",
	"ишо": "iso", "iso": "ишо",
	"нп": "nod", "nod": "нп",
}

// Repo is the catalog reader over a swappable read-only handle.
type Repo struct{ h *sqlitedb.Handle }

func New(h *sqlitedb.Handle) *Repo { return &Repo{h: h} }

func (r *Repo) db() *sql.DB { return r.h.DB() }

// ── Source dict ────────────────────────────────────────────────────────────

// Source is one book in the source dict (both-language code/name maps).
type Source struct {
	ID    string
	Codes map[string]string // lang -> short_name
	Names map[string]string // lang -> full_name
	ord   int
}

// SourceDict is the loaded source dictionary + a normalized short_name index
// for reference resolution.
type SourceDict struct {
	byID     map[string]*Source
	order    []string
	shortIdx map[string]string // normalized short_name -> source_id
}

func normKey(s string) string {
	return strings.ToLower(strings.Join(strings.Fields(s), " "))
}

// LoadSources reads the whole source dict from the current DB.
func (r *Repo) LoadSources(ctx context.Context) (*SourceDict, error) {
	rows, err := r.db().QueryContext(ctx,
		`SELECT id, language, full_name, short_name FROM sources ORDER BY id, language`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	d := &SourceDict{byID: map[string]*Source{}, shortIdx: map[string]string{}}
	next := 0
	for rows.Next() {
		var id, lang, full, short string
		if err := rows.Scan(&id, &lang, &full, &short); err != nil {
			return nil, err
		}
		s, ok := d.byID[id]
		if !ok {
			s = &Source{ID: id, Codes: map[string]string{}, Names: map[string]string{}, ord: next}
			d.byID[id] = s
			d.order = append(d.order, id)
			next++
		}
		s.Codes[lang] = short
		s.Names[lang] = full
		if k := normKey(short); k != "" {
			d.shortIdx[k] = id
		}
	}
	return d, rows.Err()
}

// Get returns a source by id.
func (d *SourceDict) Get(id string) (*Source, bool) { s, ok := d.byID[id]; return s, ok }

// Order returns source ids in stable (first-seen) order.
func (d *SourceDict) Order() []string { return d.order }

// ResolveBook maps a human book code ("BG", "БГ", "CC Madhya") to a source_id.
func (d *SourceDict) ResolveBook(book string) (string, bool) {
	k := normKey(book)
	if id, ok := d.shortIdx[k]; ok {
		return id, true
	}
	if alt, ok := crossAlias[k]; ok {
		if id, ok := d.shortIdx[alt]; ok {
			return id, true
		}
	}
	return "", false
}

// Code returns the short_name of a source in lang (fallback en, then any).
func (s *Source) Code(lang string) string { return pick(s.Codes, lang) }

// Name returns the full_name of a source in lang (fallback en, then any).
func (s *Source) Name(lang string) string { return pick(s.Names, lang) }

func pick(m map[string]string, lang string) string {
	if lang != "" {
		if v, ok := m[lang]; ok {
			return v
		}
	}
	if v, ok := m["en"]; ok {
		return v
	}
	for _, v := range m {
		return v
	}
	return ""
}

// ── Author / location dicts ────────────────────────────────────────────────

// Entity is a dict entry with a per-language name (authors, locations).
type Entity struct {
	ID    string
	Names map[string]string
	ord   int
}

// Name returns the entity name in lang (fallback en, then any).
func (e *Entity) Name(lang string) string { return pick(e.Names, lang) }

// EntityDict is a loaded author/location dictionary.
type EntityDict struct {
	byID  map[string]*Entity
	order []string
}

// Get returns an entity by id.
func (d *EntityDict) Get(id string) (*Entity, bool) { e, ok := d.byID[id]; return e, ok }

// Order returns entity ids in stable order.
func (d *EntityDict) Order() []string { return d.order }

func (r *Repo) loadEntities(ctx context.Context, table string) (*EntityDict, error) {
	rows, err := r.db().QueryContext(ctx,
		fmt.Sprintf(`SELECT id, language, full_name FROM %s ORDER BY id, language`, table))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	d := &EntityDict{byID: map[string]*Entity{}}
	next := 0
	for rows.Next() {
		var id, lang, full string
		if err := rows.Scan(&id, &lang, &full); err != nil {
			return nil, err
		}
		e, ok := d.byID[id]
		if !ok {
			e = &Entity{ID: id, Names: map[string]string{}, ord: next}
			d.byID[id] = e
			d.order = append(d.order, id)
			next++
		}
		e.Names[lang] = full
	}
	return d, rows.Err()
}

// LoadAuthors loads the author dict.
func (r *Repo) LoadAuthors(ctx context.Context) (*EntityDict, error) {
	return r.loadEntities(ctx, "authors")
}

// LoadLocations loads the location dict.
func (r *Repo) LoadLocations(ctx context.Context) (*EntityDict, error) {
	return r.loadEntities(ctx, "locations")
}

// ── Tracks ─────────────────────────────────────────────────────────────────

// RefRow is a single track_references entry.
type RefRow struct {
	SourceID string
	Tokens   string
}

// Track is the assembled per-track metadata.
type Track struct {
	ID              string
	AuthorID        string
	LocationID      string
	Date            string
	Titles          map[string]string // lang -> title
	Durations       map[string]int64  // lang -> audio_duration (ms)
	Languages       []string          // variant languages (stable order)
	TranscriptLangs map[string]bool   // lang -> has transcript_path
	HasOutline      bool              // any variant has an aligned outline (has_pdf proxy)
	TagIDs          []string
	Refs            []RefRow
}

// Kind derives lecture|conversation from the track's tags.
func (t *Track) Kind() string {
	for _, tag := range t.TagIDs {
		if convTags[tag] {
			return "conversation"
		}
	}
	return "lecture"
}

// Title returns the track title preferring lang, then en, then any variant.
func (t *Track) Title(lang string) string { return pick(t.Titles, lang) }

// Duration returns the audio duration for the preferred variant language.
func (t *Track) Duration(lang string) int64 {
	if lang != "" {
		if d, ok := t.Durations[lang]; ok {
			return d
		}
	}
	if d, ok := t.Durations["en"]; ok {
		return d
	}
	for _, d := range t.Durations {
		return d
	}
	return 0
}

// GetTrack assembles full metadata for one track, or (nil,nil) if it is
// missing or hidden.
func (r *Repo) GetTrack(ctx context.Context, id string) (*Track, error) {
	db := r.db()
	var authorID, locationID, date sql.NullString
	var hidden int
	err := db.QueryRowContext(ctx,
		`SELECT author_id, location_id, date, hidden FROM tracks WHERE id = ?`, id).
		Scan(&authorID, &locationID, &date, &hidden)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if hidden == 1 {
		return nil, nil
	}
	t := &Track{
		ID:              id,
		AuthorID:        authorID.String,
		LocationID:      locationID.String,
		Date:            date.String,
		Titles:          map[string]string{},
		Durations:       map[string]int64{},
		TranscriptLangs: map[string]bool{},
	}
	if err := r.fillVariants(ctx, t); err != nil {
		return nil, err
	}
	if err := r.fillTags(ctx, t); err != nil {
		return nil, err
	}
	if err := r.fillRefs(ctx, t); err != nil {
		return nil, err
	}
	return t, nil
}

func (r *Repo) fillVariants(ctx context.Context, t *Track) error {
	rows, err := r.db().QueryContext(ctx,
		`SELECT language, title, audio_duration, transcript_path, outline
		 FROM track_variants WHERE track_id = ? ORDER BY language`, t.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var lang, title string
		var dur sql.NullInt64
		var transcript, outline sql.NullString
		if err := rows.Scan(&lang, &title, &dur, &transcript, &outline); err != nil {
			return err
		}
		t.Languages = append(t.Languages, lang)
		t.Titles[lang] = title
		if dur.Valid {
			t.Durations[lang] = dur.Int64
		}
		if transcript.Valid && transcript.String != "" {
			t.TranscriptLangs[lang] = true
		}
		if outline.Valid && outline.String != "" {
			t.HasOutline = true
		}
	}
	return rows.Err()
}

func (r *Repo) fillTags(ctx context.Context, t *Track) error {
	rows, err := r.db().QueryContext(ctx,
		`SELECT tag_id FROM track_tags WHERE track_id = ?`, t.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var tag string
		if err := rows.Scan(&tag); err != nil {
			return err
		}
		t.TagIDs = append(t.TagIDs, tag)
	}
	return rows.Err()
}

func (r *Repo) fillRefs(ctx context.Context, t *Track) error {
	rows, err := r.db().QueryContext(ctx,
		`SELECT source_id, tokens FROM track_references WHERE track_id = ? ORDER BY ref_idx`, t.ID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var sid, tok string
		if err := rows.Scan(&sid, &tok); err != nil {
			return err
		}
		t.Refs = append(t.Refs, RefRow{SourceID: sid, Tokens: tok})
	}
	return rows.Err()
}

// HasTranscript reports whether any variant carries a transcript.
func (t *Track) HasTranscript() bool { return len(t.TranscriptLangs) > 0 }

// TrackHasRef reports whether a track cites (sourceID[, tokens]). Used by
// search's post-retrieval track filtering.
func (r *Repo) TrackHasRef(ctx context.Context, trackID, sourceID, tokens string) (bool, error) {
	q := `SELECT 1 FROM track_references WHERE track_id = ? AND source_id = ?`
	args := []any{trackID, sourceID}
	if tokens != "" {
		q += ` AND tokens = ?`
		args = append(args, tokens)
	}
	q += ` LIMIT 1`
	var one int
	err := r.db().QueryRowContext(ctx, q, args...).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// ListTracks returns tracks matching the filters, ordered date desc / id desc,
// paginated by cursor (opaque "date|id"). A returned nextCursor is "" when the
// page is the last.
type ListFilter struct {
	SourceID   string // "" = no source filter
	Tokens     string // only with SourceID
	AuthorID   string
	LocationID string
	Kind       string // lecture|conversation ("" = any)
	DateFrom   string
	DateTo     string
	Lang       string // require a transcript in this language
	Limit      int
	CursorDate string
	CursorID   string
}

func (r *Repo) ListTracks(ctx context.Context, f ListFilter) ([]*Track, error) {
	where := []string{"t.hidden = 0"}
	var args []any
	if f.SourceID != "" {
		sub := `EXISTS (SELECT 1 FROM track_references tr WHERE tr.track_id = t.id AND tr.source_id = ?`
		args = append(args, f.SourceID)
		if f.Tokens != "" {
			sub += ` AND tr.tokens = ?`
			args = append(args, f.Tokens)
		}
		sub += `)`
		where = append(where, sub)
	}
	if f.AuthorID != "" {
		where = append(where, "t.author_id = ?")
		args = append(args, f.AuthorID)
	}
	if f.LocationID != "" {
		where = append(where, "t.location_id = ?")
		args = append(args, f.LocationID)
	}
	if f.DateFrom != "" {
		where = append(where, "t.date >= ?")
		args = append(args, f.DateFrom)
	}
	if f.DateTo != "" {
		where = append(where, "t.date <= ?")
		args = append(args, f.DateTo)
	}
	if f.Lang != "" {
		where = append(where, `EXISTS (SELECT 1 FROM track_variants tv WHERE tv.track_id = t.id AND tv.language = ? AND tv.transcript_path IS NOT NULL AND tv.transcript_path <> '')`)
		args = append(args, f.Lang)
	}
	switch f.Kind {
	case "conversation":
		where = append(where, convExists(true, &args))
	case "lecture":
		where = append(where, convExists(false, &args))
	}
	if f.CursorID != "" {
		// date DESC, id DESC continuation.
		where = append(where, `(t.date < ? OR (t.date = ? AND t.id < ?))`)
		args = append(args, f.CursorDate, f.CursorDate, f.CursorID)
	}
	q := `SELECT t.id, t.author_id, t.location_id, t.date FROM tracks t WHERE ` +
		strings.Join(where, " AND ") +
		` ORDER BY t.date DESC, t.id DESC LIMIT ?`
	args = append(args, f.Limit)

	rows, err := r.db().QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []*Track
	for rows.Next() {
		var id, date string
		var author, location sql.NullString
		if err := rows.Scan(&id, &author, &location, &date); err != nil {
			return nil, err
		}
		out = append(out, &Track{
			ID: id, AuthorID: author.String, LocationID: location.String, Date: date,
			Titles: map[string]string{}, Durations: map[string]int64{}, TranscriptLangs: map[string]bool{},
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// Enrich each row with variant + tag data (bounded by Limit).
	for _, t := range out {
		if err := r.fillVariants(ctx, t); err != nil {
			return nil, err
		}
		if err := r.fillTags(ctx, t); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// convExists builds the (NOT) EXISTS predicate for the conversation tag set.
func convExists(want bool, args *[]any) string {
	tags := convTagList()
	ph := make([]string, len(tags))
	for i, tg := range tags {
		ph[i] = "?"
		*args = append(*args, tg)
	}
	kw := "EXISTS"
	if !want {
		kw = "NOT EXISTS"
	}
	return fmt.Sprintf("%s (SELECT 1 FROM track_tags tt WHERE tt.track_id = t.id AND tt.tag_id IN (%s))",
		kw, strings.Join(ph, ","))
}

// ── Reference display ───────────────────────────────────────────────────────

// RefString builds the human "CODE tokens" form for a reference in lang.
func (d *SourceDict) RefString(sourceID, tokens, lang string) string {
	code := sourceID
	if s, ok := d.byID[sourceID]; ok {
		code = s.Code(lang)
	}
	if tokens == "" {
		return code
	}
	return code + " " + tokens
}
