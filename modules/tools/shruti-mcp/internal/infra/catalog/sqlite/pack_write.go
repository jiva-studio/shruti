package sqlitecatalog

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/infra/sqliteutil"
)

// CreatePackLocaleImpl inserts one (id, language) pack row. Caller has
// already minted (or supplied) the id and resolved the per-locale
// metadata. Uniqueness is enforced by the PK on (id, language); a
// second create on an existing locale errors with a clear SQLITE_CONSTRAINT.
func (r *Repo) CreatePackLocaleImpl(ctx context.Context, id, language, name string, featured bool, sortOrder int) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	f := 0
	if featured {
		f = 1
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO packs (id, language, name, featured, sort_order) VALUES (?, ?, ?, ?, ?)`,
		id, language, name, f, sortOrder); err != nil {
		return fmt.Errorf("insert pack: %w", err)
	}
	return tx.Commit()
}

// UpdatePackLocaleImpl patches one pack locale row. Nil pointers leave
// the existing column untouched.
func (r *Repo) UpdatePackLocaleImpl(ctx context.Context, id, language string, name *string, featured *bool, sortOrder *int) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Confirm the row exists so the caller gets a NotFound rather than a
	// silent no-op on a typo'd id.
	var n int
	row := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM packs WHERE id = ? AND language = ?`, id, language)
	if err := row.Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		return fmt.Errorf("pack/%s/%s not found", id, language)
	}

	setParts := []string{}
	args := []any{}
	if name != nil {
		setParts = append(setParts, "name = ?")
		args = append(args, *name)
	}
	if featured != nil {
		setParts = append(setParts, "featured = ?")
		fv := 0
		if *featured {
			fv = 1
		}
		args = append(args, fv)
	}
	if sortOrder != nil {
		setParts = append(setParts, "sort_order = ?")
		args = append(args, *sortOrder)
	}
	if len(setParts) == 0 {
		return tx.Commit()
	}
	args = append(args, id, language)

	stmt := `UPDATE packs SET `
	for i, p := range setParts {
		if i > 0 {
			stmt += ", "
		}
		stmt += p
	}
	stmt += ` WHERE id = ? AND language = ?`
	if _, err := tx.ExecContext(ctx, stmt, args...); err != nil {
		return fmt.Errorf("update pack: %w", err)
	}
	return tx.Commit()
}

// GetPackImpl returns the pack collapsed across locales plus its ordered
// list of (language → track_id slices). Found=false when no locale exists.
func (r *Repo) GetPackImpl(ctx context.Context, id string) (catalog.Pack, map[string][]string, bool, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT id, language, name, featured, sort_order FROM packs WHERE id = ?`, id)
	if err != nil {
		return catalog.Pack{}, nil, false, err
	}
	defer rows.Close()
	pack := catalog.Pack{
		Id:        id,
		Names:     map[string]string{},
		Featured:  map[string]bool{},
		SortOrder: map[string]int{},
	}
	found := false
	for rows.Next() {
		var rid, lang, name string
		var featured, sortOrder int
		if err := rows.Scan(&rid, &lang, &name, &featured, &sortOrder); err != nil {
			return catalog.Pack{}, nil, false, err
		}
		found = true
		pack.Names[lang] = name
		pack.Featured[lang] = featured != 0
		pack.SortOrder[lang] = sortOrder
	}
	if !found {
		return catalog.Pack{}, nil, false, rows.Err()
	}

	tracksByLang := map[string][]string{}
	for lang := range pack.Names {
		ids, err := r.listPackTrackIDsForLocale(ctx, id, lang)
		if err != nil {
			return catalog.Pack{}, nil, false, err
		}
		tracksByLang[lang] = ids
	}
	return pack, tracksByLang, true, rows.Err()
}

func (r *Repo) listPackTrackIDsForLocale(ctx context.Context, packID, language string) ([]string, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT track_id FROM pack_tracks
		 WHERE pack_id = ? AND pack_language = ?
		 ORDER BY position ASC, track_id ASC`,
		packID, language)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var tid string
		if err := rows.Scan(&tid); err != nil {
			return nil, err
		}
		out = append(out, tid)
	}
	return out, rows.Err()
}

// ListPacksImpl returns packs collapsed across locales, filtered by
// opts.Language / opts.Featured. Returned without their track lists for
// compact responses.
func (r *Repo) ListPacksImpl(ctx context.Context, opts catalog.PackListOpts) ([]catalog.Pack, error) {
	if opts.Limit <= 0 {
		opts.Limit = 100
	}

	args := []any{}
	where := ""
	if opts.Language != nil {
		where = " WHERE language = ?"
		args = append(args, *opts.Language)
	}
	if opts.Featured != nil {
		fv := 0
		if *opts.Featured {
			fv = 1
		}
		if where == "" {
			where = " WHERE featured = ?"
		} else {
			where += " AND featured = ?"
		}
		args = append(args, fv)
	}

	// Pick the distinct id window in stable order, then hydrate every
	// locale row for those ids (so the caller sees the same shape it
	// gets from GetPack).
	idStmt := fmt.Sprintf(`
		SELECT DISTINCT id FROM packs%s AND id > ?
		ORDER BY id ASC
		LIMIT ?`, ifEmpty(where, " WHERE 1=1"))
	args = append(args, opts.Cursor, opts.Limit)

	idRows, err := r.db.QueryContext(ctx, idStmt, args...)
	if err != nil {
		return nil, fmt.Errorf("list pack ids: %w", err)
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

	out := make([]catalog.Pack, 0, len(ids))
	for _, id := range ids {
		// Re-read every locale row. We deliberately do NOT re-apply the
		// language filter here — once an id is included, the caller
		// sees its full per-locale metadata, mirroring ListDict.
		rows, err := r.db.QueryContext(ctx,
			`SELECT language, name, featured, sort_order FROM packs WHERE id = ?`, id)
		if err != nil {
			return nil, err
		}
		pack := catalog.Pack{
			Id:        id,
			Names:     map[string]string{},
			Featured:  map[string]bool{},
			SortOrder: map[string]int{},
		}
		for rows.Next() {
			var lang, name string
			var featured, sortOrder int
			if err := rows.Scan(&lang, &name, &featured, &sortOrder); err != nil {
				rows.Close()
				return nil, err
			}
			pack.Names[lang] = name
			pack.Featured[lang] = featured != 0
			pack.SortOrder[lang] = sortOrder
		}
		rows.Close()
		out = append(out, pack)
	}
	return out, nil
}

// DeletePackImpl removes all locales of a pack. The FK cascade clears
// pack_tracks for both locales.
func (r *Repo) DeletePackImpl(ctx context.Context, id string) error {
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `DELETE FROM packs WHERE id = ?`, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("pack/%s not found", id)
	}
	return tx.Commit()
}

// DeletePackLocaleImpl removes one (id, language) row. If it's the last
// locale, also clears any pack_tracks rows defensively (the FK cascade
// already does this, but stays explicit). The other locale's tracks are
// preserved untouched.
func (r *Repo) DeletePackLocaleImpl(ctx context.Context, id, language string) error {
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return err
	}
	defer tx.Rollback()

	res, err := tx.ExecContext(ctx,
		`DELETE FROM packs WHERE id = ? AND language = ?`, id, language)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("pack/%s/%s not found", id, language)
	}
	return tx.Commit()
}

// SetPackTracksImpl atomically replaces the full ordered membership of
// (pack_id, pack_language) with `trackIDs`. Returns NotFound if the
// pack locale doesn't exist.
func (r *Repo) SetPackTracksImpl(ctx context.Context, packID, language string, trackIDs []string) error {
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if err := assertPackLocale(ctx, tx, packID, language); err != nil {
		return err
	}

	if _, err := tx.ExecContext(ctx,
		`DELETE FROM pack_tracks WHERE pack_id = ? AND pack_language = ?`,
		packID, language); err != nil {
		return fmt.Errorf("clear pack_tracks: %w", err)
	}
	for i, tid := range trackIDs {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO pack_tracks (pack_id, pack_language, track_id, position) VALUES (?, ?, ?, ?)`,
			packID, language, tid, i); err != nil {
			return fmt.Errorf("insert pack_track[%d]: %w", i, err)
		}
	}
	return tx.Commit()
}

// AddPackTrackImpl appends a track to the pack (or inserts at the given
// position, shifting subsequent rows). Position semantics mirror "insert
// before index N"; len(existing) appends to the tail.
func (r *Repo) AddPackTrackImpl(ctx context.Context, packID, language, trackID string, position *int) error {
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if err := assertPackLocale(ctx, tx, packID, language); err != nil {
		return err
	}

	// Idempotent: if the track is already in the pack, do nothing.
	var existing int
	row := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM pack_tracks WHERE pack_id = ? AND pack_language = ? AND track_id = ?`,
		packID, language, trackID)
	if err := row.Scan(&existing); err != nil {
		return err
	}
	if existing > 0 {
		return tx.Commit()
	}

	// Compute insertion position. nil → append.
	var rowCount int
	row = tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM pack_tracks WHERE pack_id = ? AND pack_language = ?`,
		packID, language)
	if err := row.Scan(&rowCount); err != nil {
		return err
	}
	pos := rowCount
	if position != nil {
		pos = *position
		if pos < 0 {
			pos = 0
		}
		if pos > rowCount {
			pos = rowCount
		}
	}

	// Shift subsequent positions up by 1.
	if pos < rowCount {
		if _, err := tx.ExecContext(ctx,
			`UPDATE pack_tracks SET position = position + 1
			 WHERE pack_id = ? AND pack_language = ? AND position >= ?`,
			packID, language, pos); err != nil {
			return fmt.Errorf("shift positions: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO pack_tracks (pack_id, pack_language, track_id, position) VALUES (?, ?, ?, ?)`,
		packID, language, trackID, pos); err != nil {
		return fmt.Errorf("insert pack_track: %w", err)
	}
	return tx.Commit()
}

// RemovePackTrackImpl deletes one (pack, language, track_id) row and
// compacts the position sequence so callers iterating ORDER BY position
// don't see gaps. Idempotent: missing track is success.
func (r *Repo) RemovePackTrackImpl(ctx context.Context, packID, language, trackID string) error {
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if err := assertPackLocale(ctx, tx, packID, language); err != nil {
		return err
	}

	var removedPos int
	row := tx.QueryRowContext(ctx,
		`SELECT position FROM pack_tracks
		 WHERE pack_id = ? AND pack_language = ? AND track_id = ?`,
		packID, language, trackID)
	if err := row.Scan(&removedPos); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return tx.Commit()
		}
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM pack_tracks WHERE pack_id = ? AND pack_language = ? AND track_id = ?`,
		packID, language, trackID); err != nil {
		return fmt.Errorf("delete pack_track: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE pack_tracks SET position = position - 1
		 WHERE pack_id = ? AND pack_language = ? AND position > ?`,
		packID, language, removedPos); err != nil {
		return fmt.Errorf("compact positions: %w", err)
	}
	return tx.Commit()
}

func assertPackLocale(ctx context.Context, tx *sql.Tx, packID, language string) error {
	row := tx.QueryRowContext(ctx,
		`SELECT 1 FROM packs WHERE id = ? AND language = ? LIMIT 1`,
		packID, language)
	var n int
	if err := row.Scan(&n); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("pack/%s/%s not found", packID, language)
		}
		return err
	}
	return nil
}

// --- public Repo methods (with retry wrapper) ---

func (r *Repo) CreatePackLocale(ctx context.Context, id, language, name string, featured bool, sortOrder int) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		return r.CreatePackLocaleImpl(ctx, id, language, name, featured, sortOrder)
	})
}
func (r *Repo) UpdatePackLocale(ctx context.Context, id, language string, name *string, featured *bool, sortOrder *int) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		return r.UpdatePackLocaleImpl(ctx, id, language, name, featured, sortOrder)
	})
}
func (r *Repo) GetPack(ctx context.Context, id string) (catalog.Pack, map[string][]string, bool, error) {
	return r.GetPackImpl(ctx, id)
}
func (r *Repo) ListPacks(ctx context.Context, opts catalog.PackListOpts) ([]catalog.Pack, error) {
	return r.ListPacksImpl(ctx, opts)
}
func (r *Repo) DeletePack(ctx context.Context, id string) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		return r.DeletePackImpl(ctx, id)
	})
}
func (r *Repo) DeletePackLocale(ctx context.Context, id, language string) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		return r.DeletePackLocaleImpl(ctx, id, language)
	})
}
func (r *Repo) SetPackTracks(ctx context.Context, packID, language string, trackIDs []string) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		return r.SetPackTracksImpl(ctx, packID, language, trackIDs)
	})
}
func (r *Repo) AddPackTrack(ctx context.Context, packID, language, trackID string, position *int) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		return r.AddPackTrackImpl(ctx, packID, language, trackID, position)
	})
}
func (r *Repo) RemovePackTrack(ctx context.Context, packID, language, trackID string) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		return r.RemovePackTrackImpl(ctx, packID, language, trackID)
	})
}

// TrackLanguages returns the set of languages this track has a variant
// for. Used by the pack usecase to enforce the per-locale invariant
// (an EN track may not be added to an RU pack).
func (r *Repo) TrackLanguages(ctx context.Context, trackID string) ([]string, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT language FROM track_variants WHERE track_id = ?`, trackID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var lang string
		if err := rows.Scan(&lang); err != nil {
			return nil, err
		}
		out = append(out, lang)
	}
	return out, rows.Err()
}
