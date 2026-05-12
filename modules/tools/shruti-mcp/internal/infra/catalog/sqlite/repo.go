package sqlitecatalog

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	_ "github.com/mattn/go-sqlite3"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/sqliteutil"
	catalogport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/catalog"
)

// Repo wraps the downloaded catalog DB (out/artifacts/catalog/current.db).
// Phase 4 implements the read-only methods of catalogport.Repository; the
// mutating methods return ErrReadOnly until Phase 8/10 supplies them.
type Repo struct {
	db   *sql.DB
	path string
}

var ErrReadOnly = errors.New("catalog: write methods not implemented yet (Phase 8/10)")

// Open opens an existing catalog DB. The file must already exist (refresh
// is the only path that creates one).
//
// busy_timeout=60s: SaveTrack is an 8-statement transaction (tracks,
// variants, references, tags, FTS) and the dict CRUD writes wrap a
// usage_count check + DELETE under BEGIN IMMEDIATE. Under a 4-worker
// commit batch these contend; the bumped timeout gives them room while
// sqliteutil.WithRetry handles whatever still slips through.
//
// SetMaxOpenConns(4) opens up read concurrency — writes still serialize
// inside SQLite, but read-mostly callers (resolver candidate generation,
// list/get tools) no longer queue behind a single connection.
func Open(ctx context.Context, path string) (*Repo, error) {
	dsn := fmt.Sprintf("file:%s?_journal_mode=WAL&_synchronous=NORMAL&_busy_timeout=60000&_foreign_keys=on", path)
	db, err := sql.Open("sqlite3", dsn)
	if err != nil {
		return nil, fmt.Errorf("open catalog: %w", err)
	}
	db.SetMaxOpenConns(4)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping catalog: %w", err)
	}
	if err := applyLocalMigrations(ctx, db); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("apply local migrations: %w", err)
	}
	return &Repo{db: db, path: path}, nil
}

func (r *Repo) Close() error { return r.db.Close() }

func (r *Repo) Path() string { return r.path }

// Scheme reads the latest scheme from the migrations table — same query the
// mobile app uses on startup.
func (r *Repo) Scheme(ctx context.Context) (int, error) {
	row := r.db.QueryRowContext(ctx,
		`SELECT scheme FROM migrations WHERE scheme IS NOT NULL ORDER BY name DESC LIMIT 1`)
	var s int
	if err := row.Scan(&s); err != nil {
		return 0, fmt.Errorf("scheme: %w", err)
	}
	return s, nil
}

// dictTable returns the SQL table name for the given Kind.
func dictTable(k catalog.Kind) (string, error) {
	switch k {
	case catalog.KindAuthor:
		return "authors", nil
	case catalog.KindLocation:
		return "locations", nil
	case catalog.KindSource:
		return "sources", nil
	case catalog.KindTag:
		return "tags", nil
	}
	return "", fmt.Errorf("unknown kind %q", k)
}

func (r *Repo) GetDict(ctx context.Context, kind catalog.Kind, id string) (catalog.DictEntry, bool, error) {
	tbl, err := dictTable(kind)
	if err != nil {
		return catalog.DictEntry{}, false, err
	}
	cols := "id, language, full_name"
	if kind == catalog.KindSource {
		cols = "id, language, full_name, short_name"
	}
	rows, err := r.db.QueryContext(ctx,
		fmt.Sprintf(`SELECT %s FROM %s WHERE id = ?`, cols, tbl), id)
	if err != nil {
		return catalog.DictEntry{}, false, err
	}
	defer rows.Close()
	entry := catalog.DictEntry{Id: id, Names: map[string]string{}}
	if kind == catalog.KindSource {
		entry.ShortName = map[string]string{}
	}
	any := false
	for rows.Next() {
		any = true
		var rid, lang, fullName string
		var shortName sql.NullString
		if kind == catalog.KindSource {
			if err := rows.Scan(&rid, &lang, &fullName, &shortName); err != nil {
				return catalog.DictEntry{}, false, err
			}
			entry.Names[lang] = fullName
			if shortName.Valid {
				entry.ShortName[lang] = shortName.String
			}
		} else {
			if err := rows.Scan(&rid, &lang, &fullName); err != nil {
				return catalog.DictEntry{}, false, err
			}
			entry.Names[lang] = fullName
		}
	}
	return entry, any, rows.Err()
}

func (r *Repo) ListDict(ctx context.Context, kind catalog.Kind, opts catalog.ListOpts) ([]catalog.DictEntry, error) {
	tbl, err := dictTable(kind)
	if err != nil {
		return nil, err
	}
	if opts.Limit <= 0 {
		opts.Limit = 100
	}
	cols := "id, language, full_name"
	if kind == catalog.KindSource {
		cols = "id, language, full_name, short_name"
	}

	args := []any{}
	where := ""
	if opts.Language != nil {
		where += " WHERE language = ?"
		args = append(args, *opts.Language)
	}
	if opts.Query != nil {
		if where == "" {
			where += " WHERE"
		} else {
			where += " AND"
		}
		where += " full_name LIKE ?"
		args = append(args, "%"+*opts.Query+"%")
	}

	// Two-step: get the set of distinct ids in the cursor window, then fetch all locales for them.
	idQuery := fmt.Sprintf(`
		SELECT DISTINCT id FROM %s %s
		AND id > ?
		ORDER BY id
		LIMIT ?`, tbl, ifEmpty(where, "WHERE 1=1"))
	args = append(args, opts.Cursor, opts.Limit)
	idRows, err := r.db.QueryContext(ctx, idQuery, args...)
	if err != nil {
		return nil, fmt.Errorf("list ids: %w", err)
	}
	var ids []string
	for idRows.Next() {
		var id string
		if err := idRows.Scan(&id); err != nil {
			idRows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	idRows.Close()
	if err := idRows.Err(); err != nil {
		return nil, err
	}

	out := make([]catalog.DictEntry, 0, len(ids))
	for _, id := range ids {
		// Reuse GetDict to collapse locales.
		e, ok, err := r.GetDict(ctx, kind, id)
		if err != nil {
			return nil, err
		}
		if ok {
			_ = cols
			out = append(out, e)
		}
	}
	return out, nil
}

func ifEmpty(s, alt string) string {
	if s == "" {
		return alt
	}
	return s
}

// LookupIDByName resolves a canonical name to its dict id. For source
// the lookup is by `short_name` (matches what filenames carry: "SB",
// "BG"); for author/location/tag — by `full_name`. Returns ok=false
// when no row matches in this language.
//
// This is the **only** path "name → id" in the system: the lake
// registry never persists ids, so the catalog is the single source of
// truth. Callers that need id (commit, MCP tools) must go through here.
func (r *Repo) LookupIDByName(ctx context.Context, kind catalog.Kind, name, language string) (string, bool, error) {
	tbl, err := dictTable(kind)
	if err != nil {
		return "", false, err
	}
	col := "full_name"
	if kind == catalog.KindSource {
		col = "short_name"
	}
	row := r.db.QueryRowContext(ctx,
		fmt.Sprintf(`SELECT id FROM %s WHERE %s = ? AND language = ? LIMIT 1`, tbl, col),
		name, language)
	var id string
	if err := row.Scan(&id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", false, nil
		}
		return "", false, err
	}
	return id, true, nil
}

// UsageCount returns how many tracks/track_variants/track_references rows
// reference this dict id. Used to refuse Delete when > 0.
func (r *Repo) UsageCount(ctx context.Context, kind catalog.Kind, id string) (int, error) {
	var sqlText string
	switch kind {
	case catalog.KindAuthor:
		sqlText = `SELECT COUNT(*) FROM tracks WHERE author_id = ?`
	case catalog.KindLocation:
		sqlText = `SELECT COUNT(*) FROM tracks WHERE location_id = ?`
	case catalog.KindSource:
		sqlText = `SELECT COUNT(*) FROM track_references WHERE source_id = ?`
	case catalog.KindTag:
		sqlText = `SELECT COUNT(*) FROM track_tags WHERE tag_id = ?`
	default:
		return 0, fmt.Errorf("unknown kind %q", kind)
	}
	row := r.db.QueryRowContext(ctx, sqlText, id)
	var n int
	if err := row.Scan(&n); err != nil {
		return 0, err
	}
	return n, nil
}

func (r *Repo) GetTrack(ctx context.Context, id string) (catalog.TrackRow, bool, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT id, COALESCE(author_id,''), COALESCE(location_id,''), COALESCE(date,''),
		       hidden, sort_date
		FROM tracks WHERE id = ?`, id)
	var t catalog.TrackRow
	var hidden int
	if err := row.Scan(&t.Id, &t.AuthorID, &t.LocationID, &t.Date, &hidden, &t.SortDate); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return catalog.TrackRow{}, false, nil
		}
		return catalog.TrackRow{}, false, err
	}
	t.Hidden = hidden != 0
	return t, true, nil
}

func (r *Repo) GetVariant(ctx context.Context, trackID, language string) (catalog.VariantRow, bool, error) {
	row := r.db.QueryRowContext(ctx, `
		SELECT track_id, language, title,
		       COALESCE(audio_path,''), COALESCE(audio_filesize,0),
		       COALESCE(audio_duration,0), COALESCE(audio_kind,''),
		       COALESCE(transcript_path,''), COALESCE(transcript_kind,''),
		       COALESCE(sort_reference,'')
		FROM track_variants WHERE track_id = ? AND language = ?`, trackID, language)
	var v catalog.VariantRow
	if err := row.Scan(&v.TrackID, &v.Language, &v.Title, &v.AudioPath, &v.AudioFilesize,
		&v.AudioDuration, &v.AudioKind, &v.TranscriptPath, &v.TranscriptKind, &v.SortReference); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return catalog.VariantRow{}, false, nil
		}
		return catalog.VariantRow{}, false, err
	}
	return v, true, nil
}

func (r *Repo) GetTrackTags(ctx context.Context, trackID string) ([]string, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT tag_id FROM track_tags WHERE track_id = ? ORDER BY tag_id`, trackID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (r *Repo) GetReferences(ctx context.Context, trackID string) ([]catalog.TrackReference, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT source_id, tokens FROM track_references WHERE track_id = ? ORDER BY ref_idx`, trackID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []catalog.TrackReference
	for rows.Next() {
		var ref catalog.TrackReference
		if err := rows.Scan(&ref.SourceID, &ref.Tokens); err != nil {
			return nil, err
		}
		out = append(out, ref)
	}
	return out, rows.Err()
}

// --- mutating dict methods (caller is expected to have minted id) ---

// CreateDict requires a non-empty entry.Id (caller mints it via ids.Minter).
// Use the package-level helper CreateDictWithMinter to mint inline.
//
// All public mutating methods on Repo are wrapped in sqliteutil.WithRetry.
// Backing transactions are idempotent (UPSERT-shaped or guarded by the
// usage_count check), so a retry on SQLITE_BUSY restarts the whole tx
// from scratch without side-effect risk.
func (r *Repo) CreateDict(ctx context.Context, kind catalog.Kind, e catalog.DictEntry) (string, error) {
	if e.Id == "" {
		return "", ErrReadOnly // caller must mint upstream; dictcrud use case does this
	}
	var out string
	err := sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		id, err := r.CreateDictImpl(ctx, kind, e, nil)
		if err != nil {
			return err
		}
		out = id
		return nil
	})
	return out, err
}
func (r *Repo) UpdateDictLocale(ctx context.Context, kind catalog.Kind, id, language, fullName, shortName string) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		return r.UpdateDictLocaleImpl(ctx, kind, id, language, fullName, shortName)
	})
}
func (r *Repo) DeleteDictLocale(ctx context.Context, kind catalog.Kind, id, language string) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		return r.DeleteDictLocaleImpl(ctx, kind, id, language)
	})
}
func (r *Repo) DeleteDict(ctx context.Context, kind catalog.Kind, id string) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		return r.DeleteDictImpl(ctx, kind, id)
	})
}
func (r *Repo) SaveTrack(ctx context.Context, t catalog.TrackRow, v catalog.VariantRow, refs []catalog.TrackReference) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		return r.SaveTrackImpl(ctx, t, v, refs)
	})
}
func (r *Repo) DeleteTrackVariant(ctx context.Context, trackID, language string) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		return r.DeleteTrackVariantImpl(ctx, trackID, language)
	})
}

// Compile-time interface assertion.
var _ catalogport.Repository = (*Repo)(nil)
