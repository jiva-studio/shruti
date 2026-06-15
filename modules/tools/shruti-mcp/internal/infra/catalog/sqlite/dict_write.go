package sqlitecatalog

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
)

// CreateDictImpl inserts new dict rows for every locale in entry.Names.
// Mints a new id (with proper prefix) when entry.Id is empty. Caller minted
// id is used verbatim if non-empty (used by tests / restore flows).
func (r *Repo) CreateDictImpl(ctx context.Context, kind catalog.Kind, e catalog.DictEntry, mintTail func() string) (string, error) {
	tbl, err := dictTable(kind)
	if err != nil {
		return "", err
	}
	id := e.Id
	if id == "" {
		if mintTail == nil {
			return "", errors.New("CreateDict: id is empty and no minter")
		}
		id = kind.IDPrefix() + mintTail()
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()

	for lang, name := range e.Names {
		var stmt string
		var args []any
		if kind == catalog.KindSource || kind == catalog.KindTopic {
			stmt = fmt.Sprintf(`INSERT INTO %s (id, language, full_name, short_name) VALUES (?, ?, ?, ?)`, tbl)
			args = []any{id, lang, name, e.ShortName[lang]}
		} else {
			stmt = fmt.Sprintf(`INSERT INTO %s (id, language, full_name) VALUES (?, ?, ?)`, tbl)
			args = []any{id, lang, name}
		}
		if _, err := tx.ExecContext(ctx, stmt, args...); err != nil {
			return "", fmt.Errorf("insert %s/%s: %w", tbl, lang, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return "", err
	}
	return id, nil
}

func (r *Repo) UpdateDictLocaleImpl(ctx context.Context, kind catalog.Kind, id, language, fullName, shortName string) error {
	tbl, err := dictTable(kind)
	if err != nil {
		return err
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if kind == catalog.KindSource || kind == catalog.KindTopic {
		_, err = tx.ExecContext(ctx, fmt.Sprintf(`
			INSERT INTO %s (id, language, full_name, short_name) VALUES (?, ?, ?, ?)
			ON CONFLICT(id, language) DO UPDATE SET
				full_name  = excluded.full_name,
				short_name = excluded.short_name`, tbl),
			id, language, fullName, shortName)
	} else {
		_, err = tx.ExecContext(ctx, fmt.Sprintf(`
			INSERT INTO %s (id, language, full_name) VALUES (?, ?, ?)
			ON CONFLICT(id, language) DO UPDATE SET
				full_name = excluded.full_name`, tbl),
			id, language, fullName)
	}
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (r *Repo) DeleteDictLocaleImpl(ctx context.Context, kind catalog.Kind, id, language string) error {
	tbl, err := dictTable(kind)
	if err != nil {
		return err
	}
	// LevelSerializable maps to BEGIN IMMEDIATE on go-sqlite3 — acquires
	// a RESERVED lock up front so no other writer can sneak an INSERT
	// into track_* between our usage_count check and the DELETE. Without
	// this, the default DEFERRED transaction lets a concurrent commit
	// fly references in after we've already counted zero.
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// If this is the last locale, the caller should use DeleteDict.
	row := tx.QueryRowContext(ctx, fmt.Sprintf(`SELECT COUNT(*) FROM %s WHERE id = ?`, tbl), id)
	var total int
	if err := row.Scan(&total); err != nil {
		return err
	}
	if total <= 1 {
		// Only the locale we're about to delete (or fewer) exists; refuse
		// unless usage_count is 0.
		uses, err := r.usageCountTx(ctx, tx, kind, id)
		if err != nil {
			return err
		}
		if uses > 0 {
			return fmt.Errorf("cannot delete last locale: %d row(s) reference %s/%s", uses, kind, id)
		}
	}
	if _, err := tx.ExecContext(ctx,
		fmt.Sprintf(`DELETE FROM %s WHERE id = ? AND language = ?`, tbl), id, language); err != nil {
		return err
	}
	return tx.Commit()
}

func (r *Repo) DeleteDictImpl(ctx context.Context, kind catalog.Kind, id string) error {
	tbl, err := dictTable(kind)
	if err != nil {
		return err
	}
	// See DeleteDictLocaleImpl — same race, same fix.
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return err
	}
	defer tx.Rollback()

	uses, err := r.usageCountTx(ctx, tx, kind, id)
	if err != nil {
		return err
	}
	if uses > 0 {
		return fmt.Errorf("cannot delete %s/%s: %d row(s) reference it", kind, id, uses)
	}
	if _, err := tx.ExecContext(ctx, fmt.Sprintf(`DELETE FROM %s WHERE id = ?`, tbl), id); err != nil {
		return err
	}
	return tx.Commit()
}

func (r *Repo) usageCountTx(ctx context.Context, tx *sql.Tx, kind catalog.Kind, id string) (int, error) {
	var stmt string
	switch kind {
	case catalog.KindAuthor:
		stmt = `SELECT COUNT(*) FROM tracks WHERE author_id = ?`
	case catalog.KindLocation:
		stmt = `SELECT COUNT(*) FROM tracks WHERE location_id = ?`
	case catalog.KindSource:
		stmt = `SELECT COUNT(*) FROM track_references WHERE source_id = ?`
	case catalog.KindTag:
		stmt = `SELECT COUNT(*) FROM track_tags WHERE tag_id = ?`
	default:
		return 0, fmt.Errorf("unknown kind %q", kind)
	}
	row := tx.QueryRowContext(ctx, stmt, id)
	var n int
	if err := row.Scan(&n); err != nil {
		return 0, err
	}
	return n, nil
}
