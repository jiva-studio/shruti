package sqlitecatalog

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/infra/sqliteutil"
)

// CreateCollectionLocaleImpl inserts one (id, language) collection row. Caller has
// already minted (or supplied) the id and resolved the per-locale
// metadata. Uniqueness is enforced by the PK on (id, language); a
// second create on an existing locale errors with a clear SQLITE_CONSTRAINT.
func (r *Repo) CreateCollectionLocaleImpl(ctx context.Context, id, language, name string, featured bool, sortOrder int) error {
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
		`INSERT INTO collections (id, language, name, featured, sort_order) VALUES (?, ?, ?, ?, ?)`,
		id, language, name, f, sortOrder); err != nil {
		return fmt.Errorf("insert collection: %w", err)
	}
	return tx.Commit()
}

// UpdateCollectionLocaleImpl patches one collection locale row. Nil pointers leave
// the existing column untouched.
func (r *Repo) UpdateCollectionLocaleImpl(ctx context.Context, id, language string, name *string, featured *bool, sortOrder *int) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Confirm the row exists so the caller gets a NotFound rather than a
	// silent no-op on a typo'd id.
	var n int
	row := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM collections WHERE id = ? AND language = ?`, id, language)
	if err := row.Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		return fmt.Errorf("collection/%s/%s not found", id, language)
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

	stmt := `UPDATE collections SET `
	for i, p := range setParts {
		if i > 0 {
			stmt += ", "
		}
		stmt += p
	}
	stmt += ` WHERE id = ? AND language = ?`
	if _, err := tx.ExecContext(ctx, stmt, args...); err != nil {
		return fmt.Errorf("update collection: %w", err)
	}
	return tx.Commit()
}

// GetCollectionImpl returns the collection collapsed across locales plus its ordered
// list of (language → track_id slices). Found=false when no locale exists.
func (r *Repo) GetCollectionImpl(ctx context.Context, id string) (catalog.Collection, map[string][]string, bool, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT id, language, name, featured, sort_order FROM collections WHERE id = ?`, id)
	if err != nil {
		return catalog.Collection{}, nil, false, err
	}
	defer rows.Close()
	collection := catalog.Collection{
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
			return catalog.Collection{}, nil, false, err
		}
		found = true
		collection.Names[lang] = name
		collection.Featured[lang] = featured != 0
		collection.SortOrder[lang] = sortOrder
	}
	if !found {
		return catalog.Collection{}, nil, false, rows.Err()
	}

	tracksByLang := map[string][]string{}
	for lang := range collection.Names {
		ids, err := r.listCollectionTrackIDsForLocale(ctx, id, lang)
		if err != nil {
			return catalog.Collection{}, nil, false, err
		}
		tracksByLang[lang] = ids
	}
	return collection, tracksByLang, true, rows.Err()
}

func (r *Repo) listCollectionTrackIDsForLocale(ctx context.Context, collectionID, language string) ([]string, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT track_id FROM collection_tracks
		 WHERE collection_id = ? AND collection_language = ?
		 ORDER BY position ASC, track_id ASC`,
		collectionID, language)
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

// ListCollectionsImpl returns collections collapsed across locales, filtered by
// opts.Language / opts.Featured. Returned without their track lists for
// compact responses.
func (r *Repo) ListCollectionsImpl(ctx context.Context, opts catalog.CollectionListOpts) ([]catalog.Collection, error) {
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
	// gets from GetCollection).
	idStmt := fmt.Sprintf(`
		SELECT DISTINCT id FROM collections%s AND id > ?
		ORDER BY id ASC
		LIMIT ?`, ifEmpty(where, " WHERE 1=1"))
	args = append(args, opts.Cursor, opts.Limit)

	idRows, err := r.db.QueryContext(ctx, idStmt, args...)
	if err != nil {
		return nil, fmt.Errorf("list collection ids: %w", err)
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

	out := make([]catalog.Collection, 0, len(ids))
	for _, id := range ids {
		// Re-read every locale row. We deliberately do NOT re-apply the
		// language filter here — once an id is included, the caller
		// sees its full per-locale metadata, mirroring ListDict.
		rows, err := r.db.QueryContext(ctx,
			`SELECT language, name, featured, sort_order FROM collections WHERE id = ?`, id)
		if err != nil {
			return nil, err
		}
		collection := catalog.Collection{
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
			collection.Names[lang] = name
			collection.Featured[lang] = featured != 0
			collection.SortOrder[lang] = sortOrder
		}
		rows.Close()
		out = append(out, collection)
	}
	return out, nil
}

// DeleteCollectionImpl removes all locales of a collection. The FK cascade clears
// collection_tracks for both locales.
func (r *Repo) DeleteCollectionImpl(ctx context.Context, id string) error {
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `DELETE FROM collections WHERE id = ?`, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("collection/%s not found", id)
	}
	return tx.Commit()
}

// DeleteCollectionLocaleImpl removes one (id, language) row. If it's the last
// locale, also clears any collection_tracks rows defensively (the FK cascade
// already does this, but stays explicit). The other locale's tracks are
// preserved untouched.
func (r *Repo) DeleteCollectionLocaleImpl(ctx context.Context, id, language string) error {
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return err
	}
	defer tx.Rollback()

	res, err := tx.ExecContext(ctx,
		`DELETE FROM collections WHERE id = ? AND language = ?`, id, language)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return fmt.Errorf("collection/%s/%s not found", id, language)
	}
	return tx.Commit()
}

// SetCollectionTracksImpl atomically replaces the full ordered membership of
// (collection_id, collection_language) with `trackIDs`. Returns NotFound if the
// collection locale doesn't exist.
func (r *Repo) SetCollectionTracksImpl(ctx context.Context, collectionID, language string, trackIDs []string) error {
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if err := assertCollectionLocale(ctx, tx, collectionID, language); err != nil {
		return err
	}

	if _, err := tx.ExecContext(ctx,
		`DELETE FROM collection_tracks WHERE collection_id = ? AND collection_language = ?`,
		collectionID, language); err != nil {
		return fmt.Errorf("clear collection_tracks: %w", err)
	}
	for i, tid := range trackIDs {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO collection_tracks (collection_id, collection_language, track_id, position) VALUES (?, ?, ?, ?)`,
			collectionID, language, tid, i); err != nil {
			return fmt.Errorf("insert collection_track[%d]: %w", i, err)
		}
	}
	return tx.Commit()
}

// AddCollectionTrackImpl appends a track to the collection (or inserts at the given
// position, shifting subsequent rows). Position semantics mirror "insert
// before index N"; len(existing) appends to the tail.
func (r *Repo) AddCollectionTrackImpl(ctx context.Context, collectionID, language, trackID string, position *int) error {
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if err := assertCollectionLocale(ctx, tx, collectionID, language); err != nil {
		return err
	}

	// Idempotent: if the track is already in the collection, do nothing.
	var existing int
	row := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM collection_tracks WHERE collection_id = ? AND collection_language = ? AND track_id = ?`,
		collectionID, language, trackID)
	if err := row.Scan(&existing); err != nil {
		return err
	}
	if existing > 0 {
		return tx.Commit()
	}

	// Compute insertion position. nil → append.
	var rowCount int
	row = tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM collection_tracks WHERE collection_id = ? AND collection_language = ?`,
		collectionID, language)
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
			`UPDATE collection_tracks SET position = position + 1
			 WHERE collection_id = ? AND collection_language = ? AND position >= ?`,
			collectionID, language, pos); err != nil {
			return fmt.Errorf("shift positions: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO collection_tracks (collection_id, collection_language, track_id, position) VALUES (?, ?, ?, ?)`,
		collectionID, language, trackID, pos); err != nil {
		return fmt.Errorf("insert collection_track: %w", err)
	}
	return tx.Commit()
}

// RemoveCollectionTrackImpl deletes one (collection, language, track_id) row and
// compacts the position sequence so callers iterating ORDER BY position
// don't see gaps. Idempotent: missing track is success.
func (r *Repo) RemoveCollectionTrackImpl(ctx context.Context, collectionID, language, trackID string) error {
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if err := assertCollectionLocale(ctx, tx, collectionID, language); err != nil {
		return err
	}

	var removedPos int
	row := tx.QueryRowContext(ctx,
		`SELECT position FROM collection_tracks
		 WHERE collection_id = ? AND collection_language = ? AND track_id = ?`,
		collectionID, language, trackID)
	if err := row.Scan(&removedPos); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return tx.Commit()
		}
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM collection_tracks WHERE collection_id = ? AND collection_language = ? AND track_id = ?`,
		collectionID, language, trackID); err != nil {
		return fmt.Errorf("delete collection_track: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE collection_tracks SET position = position - 1
		 WHERE collection_id = ? AND collection_language = ? AND position > ?`,
		collectionID, language, removedPos); err != nil {
		return fmt.Errorf("compact positions: %w", err)
	}
	return tx.Commit()
}

func assertCollectionLocale(ctx context.Context, tx *sql.Tx, collectionID, language string) error {
	row := tx.QueryRowContext(ctx,
		`SELECT 1 FROM collections WHERE id = ? AND language = ? LIMIT 1`,
		collectionID, language)
	var n int
	if err := row.Scan(&n); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("collection/%s/%s not found", collectionID, language)
		}
		return err
	}
	return nil
}

// --- public Repo methods (with retry wrapper) ---

func (r *Repo) CreateCollectionLocale(ctx context.Context, id, language, name string, featured bool, sortOrder int) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		return r.CreateCollectionLocaleImpl(ctx, id, language, name, featured, sortOrder)
	})
}
func (r *Repo) UpdateCollectionLocale(ctx context.Context, id, language string, name *string, featured *bool, sortOrder *int) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		return r.UpdateCollectionLocaleImpl(ctx, id, language, name, featured, sortOrder)
	})
}
func (r *Repo) GetCollection(ctx context.Context, id string) (catalog.Collection, map[string][]string, bool, error) {
	return r.GetCollectionImpl(ctx, id)
}
func (r *Repo) ListCollections(ctx context.Context, opts catalog.CollectionListOpts) ([]catalog.Collection, error) {
	return r.ListCollectionsImpl(ctx, opts)
}
func (r *Repo) DeleteCollection(ctx context.Context, id string) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		return r.DeleteCollectionImpl(ctx, id)
	})
}
func (r *Repo) DeleteCollectionLocale(ctx context.Context, id, language string) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		return r.DeleteCollectionLocaleImpl(ctx, id, language)
	})
}
func (r *Repo) SetCollectionTracks(ctx context.Context, collectionID, language string, trackIDs []string) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		return r.SetCollectionTracksImpl(ctx, collectionID, language, trackIDs)
	})
}
func (r *Repo) AddCollectionTrack(ctx context.Context, collectionID, language, trackID string, position *int) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		return r.AddCollectionTrackImpl(ctx, collectionID, language, trackID, position)
	})
}
func (r *Repo) RemoveCollectionTrack(ctx context.Context, collectionID, language, trackID string) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		return r.RemoveCollectionTrackImpl(ctx, collectionID, language, trackID)
	})
}

// TrackLanguages returns the set of languages this track has a variant
// for. Used by the collection usecase to enforce the per-locale invariant
// (an EN track may not be added to an RU collection).
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
