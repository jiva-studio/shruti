package catalogdb

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// Step is one ordered migration of a published database. Up runs inside the
// step's own transaction; a step whose Up is nil is covered by the baseline
// DDL, so a fresh file gets its effect from the baseline and an older file
// already carries it.
type Step struct {
	Name string
	// Scheme is the published scheme the step moves the file to; 0 leaves the
	// scheme where it is and is recorded as NULL.
	Scheme int
	// ForeignKeysOff runs the step on a connection with foreign-key
	// enforcement off, for a rebuild that drops and recreates a parent table:
	// with enforcement on, the DROP would cascade into every child row.
	ForeignKeysOff bool
	// Needed, when set, is asked before the step runs; a step whose effect
	// the file already has is skipped. An unrecorded format depends on it.
	Needed func(ctx context.Context, q Querier) (bool, error)
	Up     func(ctx context.Context, tx *sql.Tx) error
}

// plan is the complete history of one database format.
//
// With recorded set, every applied step is written to `migrations` and runs
// once. Without it the format has no such table (library.db never had one and
// its readers see every table), so each step probes the schema and does
// nothing when its effect is already there.
type plan struct {
	format   string
	baseline []string
	steps    []Step
	recorded bool
}

const nowMillisSQL = `CAST((strftime('%s','now')||substr(strftime('%f','now'),4)) AS INTEGER)`

func (p plan) migrate(ctx context.Context, db *sql.DB) error {
	empty, err := isEmptyDatabase(ctx, db)
	if err != nil {
		return fmt.Errorf("%s: inspect schema: %w", p.format, err)
	}
	if empty {
		if err := p.createBaseline(ctx, db); err != nil {
			return fmt.Errorf("%s: create baseline: %w", p.format, err)
		}
	}
	applied := map[string]bool{}
	if p.recorded {
		if applied, err = appliedSteps(ctx, db); err != nil {
			return fmt.Errorf("%s: read migrations: %w", p.format, err)
		}
	}
	for _, s := range p.steps {
		if applied[s.Name] {
			continue
		}
		if s.Up == nil {
			return fmt.Errorf("%s: %s is not recorded; the file predates every migration this binary can apply", p.format, s.Name)
		}
		if s.Needed != nil {
			needed, err := s.Needed(ctx, db)
			if err != nil {
				return fmt.Errorf("%s migration %s: probe: %w", p.format, s.Name, err)
			}
			if !needed {
				continue
			}
		}
		if err := p.apply(ctx, db, s); err != nil {
			return fmt.Errorf("%s migration %s: %w", p.format, s.Name, err)
		}
	}
	return nil
}

func (p plan) createBaseline(ctx context.Context, db *sql.DB) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, stmt := range p.baseline {
		if _, err := tx.ExecContext(ctx, stmt); err != nil {
			return fmt.Errorf("%s: %w", firstLine(stmt), err)
		}
	}
	if p.recorded {
		for _, s := range p.steps {
			if s.Up != nil {
				continue
			}
			if err := record(ctx, tx, s); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

func (p plan) apply(ctx context.Context, db *sql.DB, s Step) (err error) {
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()

	if s.ForeignKeysOff {
		restore, err := disableForeignKeys(ctx, conn)
		if err != nil {
			return err
		}
		defer func() { err = errors.Join(err, restore()) }()
	}

	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := s.Up(ctx, tx); err != nil {
		return err
	}
	if p.recorded {
		if err := record(ctx, tx, s); err != nil {
			return err
		}
	}
	if s.ForeignKeysOff {
		if err := checkForeignKeys(ctx, tx); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func record(ctx context.Context, tx *sql.Tx, s Step) error {
	var scheme any
	if s.Scheme != 0 {
		scheme = s.Scheme
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO migrations (name, scheme, applied_at) VALUES (?, ?, `+nowMillisSQL+`)`,
		s.Name, scheme); err != nil {
		return fmt.Errorf("record %s: %w", s.Name, err)
	}
	return nil
}

// disableForeignKeys turns enforcement off on conn and returns the function
// that puts back whatever the connection had. The pragma is a no-op inside a
// transaction, so it is set before the step's transaction begins.
func disableForeignKeys(ctx context.Context, conn *sql.Conn) (func() error, error) {
	var was int
	if err := conn.QueryRowContext(ctx, `PRAGMA foreign_keys`).Scan(&was); err != nil {
		return nil, fmt.Errorf("read foreign_keys: %w", err)
	}
	if _, err := conn.ExecContext(ctx, `PRAGMA foreign_keys = OFF`); err != nil {
		return nil, fmt.Errorf("disable foreign_keys: %w", err)
	}
	return func() error {
		if _, err := conn.ExecContext(ctx, fmt.Sprintf(`PRAGMA foreign_keys = %d`, was)); err != nil {
			return fmt.Errorf("restore foreign_keys: %w", err)
		}
		return nil
	}, nil
}

// checkForeignKeys refuses a rebuild that left a child row pointing nowhere.
func checkForeignKeys(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, `PRAGMA foreign_key_check`)
	if err != nil {
		return fmt.Errorf("foreign_key_check: %w", err)
	}
	defer rows.Close()
	if rows.Next() {
		return errors.New("foreign_key_check: the rebuild left dangling references")
	}
	return rows.Err()
}

func isEmptyDatabase(ctx context.Context, db *sql.DB) (bool, error) {
	var n int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master`).Scan(&n); err != nil {
		return false, err
	}
	return n == 0, nil
}

func appliedSteps(ctx context.Context, db *sql.DB) (map[string]bool, error) {
	has, err := tableExists(ctx, db, "migrations")
	if err != nil || !has {
		return map[string]bool{}, err
	}
	rows, err := db.QueryContext(ctx, `SELECT name FROM migrations`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out[name] = true
	}
	return out, rows.Err()
}

func tableExists(ctx context.Context, q Querier, name string) (bool, error) {
	var n int
	if err := q.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, name).Scan(&n); err != nil {
		return false, err
	}
	return n > 0, nil
}

// tableSQL returns the CREATE statement sqlite_master holds for a table, and
// false when there is no such table.
func tableSQL(ctx context.Context, q Querier, name string) (string, bool, error) {
	var ddl string
	err := q.QueryRowContext(ctx,
		`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, name).Scan(&ddl)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return ddl, true, nil
}

func columnExists(ctx context.Context, q Querier, table, col string) (bool, error) {
	var n int
	if err := q.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM pragma_table_info(?) WHERE name = ?`, table, col).Scan(&n); err != nil {
		return false, err
	}
	return n > 0, nil
}

// execAll runs statements in order inside tx.
func execAll(ctx context.Context, tx *sql.Tx, stmts ...string) error {
	for _, s := range stmts {
		if _, err := tx.ExecContext(ctx, s); err != nil {
			return fmt.Errorf("%s: %w", firstLine(s), err)
		}
	}
	return nil
}

// createTableIfMissing creates a table from its published DDL when the file
// does not have it yet.
func createTableIfMissing(ctx context.Context, tx *sql.Tx, name, ddl string, indexes ...string) error {
	has, err := tableExists(ctx, tx, name)
	if err != nil {
		return err
	}
	if !has {
		if err := execAll(ctx, tx, ddl); err != nil {
			return err
		}
	}
	for _, idx := range indexes {
		if err := createIndexIfMissing(ctx, tx, idx); err != nil {
			return err
		}
	}
	return nil
}

// createIndexIfMissing runs a published CREATE INDEX statement unless an index
// of that name already exists.
func createIndexIfMissing(ctx context.Context, tx *sql.Tx, ddl string) error {
	name, err := indexName(ddl)
	if err != nil {
		return err
	}
	has, err := indexExists(ctx, tx, name)
	if err != nil || has {
		return err
	}
	return execAll(ctx, tx, ddl)
}

// addColumnsIfMissing appends nullable TEXT columns a table does not have yet.
func addColumnsIfMissing(ctx context.Context, tx *sql.Tx, table string, cols ...string) error {
	for _, col := range cols {
		has, err := columnExists(ctx, tx, table, col)
		if err != nil {
			return err
		}
		if has {
			continue
		}
		// Identifiers cannot be bound; both come from this package's constants.
		if _, err := tx.ExecContext(ctx, fmt.Sprintf(`ALTER TABLE %s ADD COLUMN %s TEXT`, table, col)); err != nil {
			return fmt.Errorf("add %s.%s: %w", table, col, err)
		}
	}
	return nil
}

func firstLine(s string) string {
	for i, r := range s {
		if r == '\n' {
			return s[:i]
		}
	}
	return s
}
