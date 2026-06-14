package sqlitecatalog

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/sqliteutil"
)

// CreateCollectionGroupLocaleImpl inserts one (id, language) group row.
func (r *Repo) CreateCollectionGroupLocaleImpl(ctx context.Context, id, language, name, description, meta string, sortOrder int) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO collection_groups (id, language, name, description, meta, sort_order) VALUES (?, ?, ?, ?, ?, ?)`,
		id, language, name, description, meta, sortOrder); err != nil {
		return fmt.Errorf("insert collection_group: %w", err)
	}
	return tx.Commit()
}

// UpdateCollectionGroupLocaleImpl patches one group locale row; nil leaves a
// column untouched.
func (r *Repo) UpdateCollectionGroupLocaleImpl(ctx context.Context, id, language string, name, description, meta *string, sortOrder *int) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var n int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM collection_groups WHERE id = ? AND language = ?`, id, language).Scan(&n); err != nil {
		return err
	}
	if n == 0 {
		return fmt.Errorf("collection_group/%s/%s not found", id, language)
	}

	setParts := []string{}
	args := []any{}
	if name != nil {
		setParts = append(setParts, "name = ?")
		args = append(args, *name)
	}
	if description != nil {
		setParts = append(setParts, "description = ?")
		args = append(args, *description)
	}
	if meta != nil {
		setParts = append(setParts, "meta = ?")
		args = append(args, *meta)
	}
	if sortOrder != nil {
		setParts = append(setParts, "sort_order = ?")
		args = append(args, *sortOrder)
	}
	if len(setParts) == 0 {
		return tx.Commit()
	}
	args = append(args, id, language)
	stmt := `UPDATE collection_groups SET ` + strings.Join(setParts, ", ") + ` WHERE id = ? AND language = ?`
	if _, err := tx.ExecContext(ctx, stmt, args...); err != nil {
		return fmt.Errorf("update collection_group: %w", err)
	}
	return tx.Commit()
}

// GetCollectionGroupImpl returns the group collapsed across locales plus its
// ordered (language → collection_id slices). Found=false when no locale exists.
func (r *Repo) GetCollectionGroupImpl(ctx context.Context, id string) (catalog.CollectionGroup, map[string][]string, bool, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT language, name, description, meta, sort_order FROM collection_groups WHERE id = ?`, id)
	if err != nil {
		return catalog.CollectionGroup{}, nil, false, err
	}
	g := catalog.CollectionGroup{
		Id:           id,
		Names:        map[string]string{},
		Descriptions: map[string]string{},
		Meta:         map[string]string{},
		SortOrder:    map[string]int{},
	}
	found := false
	for rows.Next() {
		var lang, name string
		var description, meta sql.NullString
		var sortOrder int
		if err := rows.Scan(&lang, &name, &description, &meta, &sortOrder); err != nil {
			rows.Close()
			return catalog.CollectionGroup{}, nil, false, err
		}
		found = true
		g.Names[lang] = name
		g.Descriptions[lang] = description.String
		g.Meta[lang] = meta.String
		g.SortOrder[lang] = sortOrder
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return catalog.CollectionGroup{}, nil, false, err
	}
	if !found {
		return catalog.CollectionGroup{}, nil, false, nil
	}
	byLang := map[string][]string{}
	for lang := range g.Names {
		ids, err := r.listGroupCollectionIDs(ctx, id, lang)
		if err != nil {
			return catalog.CollectionGroup{}, nil, false, err
		}
		byLang[lang] = ids
	}
	return g, byLang, true, nil
}

func (r *Repo) listGroupCollectionIDs(ctx context.Context, groupID, language string) ([]string, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT collection_id FROM collection_group_items
		 WHERE group_id = ? AND group_language = ?
		 ORDER BY position ASC, collection_id ASC`,
		groupID, language)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var cid string
		if err := rows.Scan(&cid); err != nil {
			return nil, err
		}
		out = append(out, cid)
	}
	return out, rows.Err()
}

// ListCollectionGroupsImpl returns groups collapsed across locales (without
// their membership), filtered by opts.Language, ordered by id.
func (r *Repo) ListCollectionGroupsImpl(ctx context.Context, opts catalog.CollectionGroupListOpts) ([]catalog.CollectionGroup, error) {
	if opts.Limit <= 0 {
		opts.Limit = 100
	}
	conds := []string{"id > ?"}
	args := []any{opts.Cursor}
	if opts.Language != nil {
		conds = append(conds, "language = ?")
		args = append(args, *opts.Language)
	}
	args = append(args, opts.Limit)
	idStmt := fmt.Sprintf(
		`SELECT DISTINCT id FROM collection_groups WHERE %s ORDER BY id ASC LIMIT ?`,
		strings.Join(conds, " AND "))
	idRows, err := r.db.QueryContext(ctx, idStmt, args...)
	if err != nil {
		return nil, fmt.Errorf("list group ids: %w", err)
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
	out := make([]catalog.CollectionGroup, 0, len(ids))
	for _, id := range ids {
		g, _, ok, err := r.GetCollectionGroupImpl(ctx, id)
		if err != nil {
			return nil, err
		}
		if ok {
			out = append(out, g)
		}
	}
	return out, nil
}

func (r *Repo) DeleteCollectionGroupImpl(ctx context.Context, id string) error {
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `DELETE FROM collection_groups WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("collection_group/%s not found", id)
	}
	return tx.Commit()
}

func (r *Repo) DeleteCollectionGroupLocaleImpl(ctx context.Context, id, language string) error {
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `DELETE FROM collection_groups WHERE id = ? AND language = ?`, id, language)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("collection_group/%s/%s not found", id, language)
	}
	return tx.Commit()
}

// SetCollectionGroupCollectionsImpl atomically replaces the ordered membership
// of (group_id, group_language). Each collection must exist in that language.
func (r *Repo) SetCollectionGroupCollectionsImpl(ctx context.Context, groupID, language string, collectionIDs []string) error {
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := assertCollectionGroupLocale(ctx, tx, groupID, language); err != nil {
		return err
	}
	for _, cid := range collectionIDs {
		if err := assertCollectionInLanguage(ctx, tx, cid, language); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM collection_group_items WHERE group_id = ? AND group_language = ?`,
		groupID, language); err != nil {
		return fmt.Errorf("clear group items: %w", err)
	}
	for i, cid := range collectionIDs {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO collection_group_items (group_id, group_language, collection_id, position) VALUES (?, ?, ?, ?)`,
			groupID, language, cid, i); err != nil {
			return fmt.Errorf("insert group item[%d]: %w", i, err)
		}
	}
	return tx.Commit()
}

func (r *Repo) AddCollectionGroupCollectionImpl(ctx context.Context, groupID, language, collectionID string, position *int) error {
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := assertCollectionGroupLocale(ctx, tx, groupID, language); err != nil {
		return err
	}
	if err := assertCollectionInLanguage(ctx, tx, collectionID, language); err != nil {
		return err
	}
	var existing int
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM collection_group_items WHERE group_id = ? AND group_language = ? AND collection_id = ?`,
		groupID, language, collectionID).Scan(&existing); err != nil {
		return err
	}
	if existing > 0 {
		return tx.Commit()
	}
	var rowCount int
	if err := tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM collection_group_items WHERE group_id = ? AND group_language = ?`,
		groupID, language).Scan(&rowCount); err != nil {
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
	if pos < rowCount {
		if _, err := tx.ExecContext(ctx,
			`UPDATE collection_group_items SET position = position + 1
			 WHERE group_id = ? AND group_language = ? AND position >= ?`,
			groupID, language, pos); err != nil {
			return fmt.Errorf("shift positions: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO collection_group_items (group_id, group_language, collection_id, position) VALUES (?, ?, ?, ?)`,
		groupID, language, collectionID, pos); err != nil {
		return fmt.Errorf("insert group item: %w", err)
	}
	return tx.Commit()
}

func (r *Repo) RemoveCollectionGroupCollectionImpl(ctx context.Context, groupID, language, collectionID string) error {
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := assertCollectionGroupLocale(ctx, tx, groupID, language); err != nil {
		return err
	}
	var removedPos int
	err = tx.QueryRowContext(ctx,
		`SELECT position FROM collection_group_items WHERE group_id = ? AND group_language = ? AND collection_id = ?`,
		groupID, language, collectionID).Scan(&removedPos)
	if errors.Is(err, sql.ErrNoRows) {
		return tx.Commit()
	}
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM collection_group_items WHERE group_id = ? AND group_language = ? AND collection_id = ?`,
		groupID, language, collectionID); err != nil {
		return fmt.Errorf("delete group item: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE collection_group_items SET position = position - 1
		 WHERE group_id = ? AND group_language = ? AND position > ?`,
		groupID, language, removedPos); err != nil {
		return fmt.Errorf("compact positions: %w", err)
	}
	return tx.Commit()
}

func assertCollectionGroupLocale(ctx context.Context, tx *sql.Tx, groupID, language string) error {
	var n int
	err := tx.QueryRowContext(ctx,
		`SELECT 1 FROM collection_groups WHERE id = ? AND language = ? LIMIT 1`, groupID, language).Scan(&n)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("collection_group/%s/%s not found", groupID, language)
	}
	return err
}

func assertCollectionInLanguage(ctx context.Context, tx *sql.Tx, collectionID, language string) error {
	var n int
	err := tx.QueryRowContext(ctx,
		`SELECT 1 FROM collections WHERE id = ? AND language = ? LIMIT 1`, collectionID, language).Scan(&n)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("collection %q has no %s locale", collectionID, language)
	}
	return err
}

// --- public Repo methods (with retry wrapper) ---

func (r *Repo) CreateCollectionGroupLocale(ctx context.Context, id, language, name, description, meta string, sortOrder int) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		return r.CreateCollectionGroupLocaleImpl(ctx, id, language, name, description, meta, sortOrder)
	})
}
func (r *Repo) UpdateCollectionGroupLocale(ctx context.Context, id, language string, name, description, meta *string, sortOrder *int) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		return r.UpdateCollectionGroupLocaleImpl(ctx, id, language, name, description, meta, sortOrder)
	})
}
func (r *Repo) GetCollectionGroup(ctx context.Context, id string) (catalog.CollectionGroup, map[string][]string, bool, error) {
	return r.GetCollectionGroupImpl(ctx, id)
}
func (r *Repo) ListCollectionGroups(ctx context.Context, opts catalog.CollectionGroupListOpts) ([]catalog.CollectionGroup, error) {
	return r.ListCollectionGroupsImpl(ctx, opts)
}
func (r *Repo) DeleteCollectionGroup(ctx context.Context, id string) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error { return r.DeleteCollectionGroupImpl(ctx, id) })
}
func (r *Repo) DeleteCollectionGroupLocale(ctx context.Context, id, language string) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error { return r.DeleteCollectionGroupLocaleImpl(ctx, id, language) })
}
func (r *Repo) SetCollectionGroupCollections(ctx context.Context, groupID, language string, collectionIDs []string) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		return r.SetCollectionGroupCollectionsImpl(ctx, groupID, language, collectionIDs)
	})
}
func (r *Repo) AddCollectionGroupCollection(ctx context.Context, groupID, language, collectionID string, position *int) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		return r.AddCollectionGroupCollectionImpl(ctx, groupID, language, collectionID, position)
	})
}
func (r *Repo) RemoveCollectionGroupCollection(ctx context.Context, groupID, language, collectionID string) error {
	return sqliteutil.WithRetry(ctx, sqliteutil.DefaultRetry, func() error {
		return r.RemoveCollectionGroupCollectionImpl(ctx, groupID, language, collectionID)
	})
}
