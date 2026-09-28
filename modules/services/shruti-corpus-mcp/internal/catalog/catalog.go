// Package catalog reads the catalog SQLite (current.db): the source / author /
// location dictionaries (used to turn a name into an id and to resolve a
// reference book code into a source_id), and assembled tracks.
package catalog

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/jiva-studio/shruti/catalogdb"
	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/domain/corpus"
	"github.com/jiva-studio/shruti/modules/services/shruti-corpus-mcp/internal/sqlitedb"
)

// crossAlias maps a book code typed in one script to the equivalent stored
// short_name in the other. Stored short_names already carry both
// languages, so this is a fallback for codes typed in the "other" script.
var crossAlias = map[string]string{
	"бг": "bg", "bg": "бг",
	"шб": "sb", "sb": "шб",
	"ишо": "iso", "iso": "ишо",
	"нп": "nod", "nod": "нп",
}

// Repo is the catalog reader over a swappable read-only handle. Every call
// leases the current database for its own duration.
type Repo struct{ h *sqlitedb.Handle }

func New(h *sqlitedb.Handle) *Repo { return &Repo{h: h} }

// read runs fn against a lease of the current database.
func (r *Repo) read(fn func(q catalogdb.Querier) error) error {
	db, release, err := r.h.Acquire()
	if err != nil {
		return err
	}
	defer release()
	return fn(db)
}

// ── Source dict ────────────────────────────────────────────────────────────

// Source is one book in the source dict (both-language code/name maps).
type Source struct {
	ID    string
	Codes map[string]string // lang -> short_name
	Names map[string]string // lang -> full_name
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
	var rows []catalogdb.DictRow
	if err := r.read(func(q catalogdb.Querier) (err error) {
		rows, err = catalogdb.DictRows(ctx, q, catalogdb.DictSources)
		return err
	}); err != nil {
		return nil, err
	}
	d := &SourceDict{byID: map[string]*Source{}, shortIdx: map[string]string{}}
	for _, row := range rows {
		s, ok := d.byID[row.ID]
		if !ok {
			s = &Source{ID: row.ID, Codes: map[string]string{}, Names: map[string]string{}}
			d.byID[row.ID] = s
			d.order = append(d.order, row.ID)
		}
		s.Codes[row.Language] = row.ShortName
		s.Names[row.Language] = row.FullName
		if k := normKey(row.ShortName); k != "" {
			d.shortIdx[k] = row.ID
		}
	}
	return d, nil
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

func pick(m map[string]string, lang string) string { return corpus.Pick(m, lang) }

// ── Author / location dicts ────────────────────────────────────────────────

// Entity is a dict entry with a per-language name (authors, locations).
type Entity struct {
	ID    string
	Names map[string]string
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

func (r *Repo) loadEntities(ctx context.Context, dict catalogdb.Dict) (*EntityDict, error) {
	var rows []catalogdb.DictRow
	if err := r.read(func(q catalogdb.Querier) (err error) {
		rows, err = catalogdb.DictRows(ctx, q, dict)
		return err
	}); err != nil {
		return nil, err
	}
	d := &EntityDict{byID: map[string]*Entity{}}
	for _, row := range rows {
		e, ok := d.byID[row.ID]
		if !ok {
			e = &Entity{ID: row.ID, Names: map[string]string{}}
			d.byID[row.ID] = e
			d.order = append(d.order, row.ID)
		}
		e.Names[row.Language] = row.FullName
	}
	return d, nil
}

// LoadAuthors loads the author dict.
func (r *Repo) LoadAuthors(ctx context.Context) (*EntityDict, error) {
	return r.loadEntities(ctx, catalogdb.DictAuthors)
}

// LoadLocations loads the location dict.
func (r *Repo) LoadLocations(ctx context.Context) (*EntityDict, error) {
	return r.loadEntities(ctx, catalogdb.DictLocations)
}

// ── Tracks ─────────────────────────────────────────────────────────────────

// Track is the assembled per-track metadata.
type Track = corpus.Track

func newTrack(t catalogdb.Track) *Track {
	return corpus.NewTrack(t.ID, t.AuthorID, t.LocationID, t.Date)
}

// GetTrack assembles full metadata for one track, or (nil,nil) if it is
// missing or hidden.
func (r *Repo) GetTrack(ctx context.Context, id string) (*Track, error) {
	tracks, err := r.GetTracks(ctx, []string{id})
	if err != nil {
		return nil, err
	}
	return tracks[id], nil
}

// GetTracks assembles full metadata, references included, for every visible
// track among ids, with one query per table. Missing and hidden tracks are
// absent from the map.
func (r *Repo) GetTracks(ctx context.Context, ids []string) (map[string]*Track, error) {
	out := map[string]*Track{}
	err := r.read(func(q catalogdb.Querier) error {
		rows, err := catalogdb.TracksOf(ctx, q, ids)
		if err != nil {
			return err
		}
		var visible []*Track
		for _, row := range rows {
			if row.Hidden {
				continue
			}
			t := newTrack(row)
			out[t.ID] = t
			visible = append(visible, t)
		}
		return enrich(ctx, q, visible, true)
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// enrich fills variants, durations and tags — and references when withRefs
// is set — for every track with one batched read per table.
func enrich(ctx context.Context, q catalogdb.Querier, tracks []*Track, withRefs bool) error {
	if len(tracks) == 0 {
		return nil
	}
	ids := make([]string, len(tracks))
	for i, t := range tracks {
		ids[i] = t.ID
	}
	variants, err := catalogdb.VariantsOf(ctx, q, ids)
	if err != nil {
		return err
	}
	durations, err := catalogdb.AudioDurationsOf(ctx, q, ids)
	if err != nil {
		return err
	}
	tags, err := catalogdb.TagsOf(ctx, q, ids)
	if err != nil {
		return err
	}
	var refs map[string][]catalogdb.Reference
	if withRefs {
		if refs, err = catalogdb.ReferencesOf(ctx, q, ids); err != nil {
			return err
		}
	}
	for _, t := range tracks {
		for _, v := range variants[t.ID] {
			t.Languages = append(t.Languages, v.Language)
			t.Titles[v.Language] = v.Title
			if v.TranscriptPath != "" {
				t.Transcripts[v.Language] = v.TranscriptPath
			}
			if v.Outline != "" {
				t.HasOutline = true
			}
		}
		for lang, d := range durations[t.ID] {
			t.Durations[lang] = d
		}
		t.TagIDs = tags[t.ID]
		for _, ref := range refs[t.ID] {
			t.Refs = append(t.Refs, corpus.Reference{SourceID: ref.SourceID, Tokens: ref.Tokens})
		}
	}
	return nil
}

// TrackIDsByRef returns the distinct track_ids that cite (sourceID[, tokens]):
// exact tokens or any position under them ("2" covers "2.13"). Search uses it
// to pre-filter its lanes to the citing tracks.
func (r *Repo) TrackIDsByRef(ctx context.Context, sourceID, tokens string) ([]string, error) {
	var ids []string
	err := r.read(func(q catalogdb.Querier) (err error) {
		ids, err = catalogdb.TrackIDsCiting(ctx, q, sourceID, tokens)
		return err
	})
	return ids, err
}

// ListFilter narrows ListTracks. The cursor is the (date, id) of the last
// track of the previous page.
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

// ListTracks returns visible tracks matching the filters, ordered date desc /
// id desc, with variants and tags (no references).
func (r *Repo) ListTracks(ctx context.Context, f ListFilter) ([]*Track, error) {
	query, args := listTracksSQL(f)
	var out []*Track
	err := r.read(func(q catalogdb.Querier) error {
		rows, err := q.QueryContext(ctx, query, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id, date string
			var author, location sql.NullString
			if err := rows.Scan(&id, &author, &location, &date); err != nil {
				return err
			}
			out = append(out, newTrack(catalogdb.Track{
				ID: id, AuthorID: author.String, LocationID: location.String, Date: date,
			}))
		}
		if err := rows.Err(); err != nil {
			return err
		}
		return enrich(ctx, q, out, false)
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// listTracksSQL builds the filtered page query. With a source filter it starts
// from track_references (indexed by source) and joins into tracks, so only the
// citing set is sorted; without one it is a plain recent-tracks scan.
func listTracksSQL(f ListFilter) (string, []any) {
	where := []string{"t.hidden = 0"}
	var args []any
	var joinSQL string
	if f.SourceID != "" {
		joinSQL = ` JOIN (SELECT DISTINCT track_id FROM track_references WHERE source_id = ?`
		args = append(args, f.SourceID)
		if f.Tokens != "" {
			// Chapter-prefix match: exact tokens OR any token under it
			// ("2" matches "2.13"/"2.20"; "5.5" matches "5.5.3").
			joinSQL += ` AND (tokens = ? OR tokens LIKE ?)`
			args = append(args, f.Tokens, f.Tokens+".%")
		}
		joinSQL += `) r ON r.track_id = t.id`
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
		where = append(where, `(t.date < ? OR (t.date = ? AND t.id < ?))`)
		args = append(args, f.CursorDate, f.CursorDate, f.CursorID)
	}
	query := `SELECT t.id, t.author_id, t.location_id, t.date FROM tracks t` +
		joinSQL + ` WHERE ` + strings.Join(where, " AND ") +
		` ORDER BY t.date DESC, t.id DESC LIMIT ?`
	return query, append(args, f.Limit)
}

// convExists builds the (NOT) EXISTS predicate for the conversation tag set.
func convExists(want bool, args *[]any) string {
	tags := corpus.ConversationTags()
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
