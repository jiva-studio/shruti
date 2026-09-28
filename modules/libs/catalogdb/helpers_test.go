package catalogdb

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	_ "github.com/mattn/go-sqlite3"
	_ "modernc.org/sqlite"
)

// driver is one of the two SQLite drivers the package has to work under.
type driver struct {
	name string
	sql  string
	dsn  func(path string) string
}

var drivers = []driver{
	{"mattn", "sqlite3", func(p string) string { return "file:" + p + "?_foreign_keys=on" }},
	{"modernc", "sqlite", func(p string) string { return "file:" + p + "?_pragma=foreign_keys(1)" }},
}

// forEachDriver runs a subtest per driver.
func forEachDriver(t *testing.T, fn func(t *testing.T, d driver)) {
	t.Helper()
	for _, d := range drivers {
		t.Run(d.name, func(t *testing.T) { fn(t, d) })
	}
}

// catalogWriter runs a subtest under the driver that can write a catalog:
// tracks_search is an FTS4 table and modernc.org/sqlite is built without
// FTS4, so it can read a catalog but not create or reindex one.
func catalogWriter(t *testing.T, fn func(t *testing.T, d driver)) {
	t.Helper()
	t.Run(drivers[0].name, func(t *testing.T) { fn(t, drivers[0]) })
}

// openFile opens a new database file under the test's temp dir.
func openFile(t *testing.T, d driver) *sql.DB {
	t.Helper()
	db, err := sql.Open(d.sql, d.dsn(filepath.Join(t.TempDir(), "test.db")))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() {
		if err := db.Close(); err != nil {
			t.Errorf("close: %v", err)
		}
	})
	return db
}

// freshCatalog opens a new file and migrates it.
func freshCatalog(t *testing.T, d driver) *sql.DB {
	t.Helper()
	db := openFile(t, d)
	if err := MigrateCatalog(t.Context(), db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return db
}

func freshLibrary(t *testing.T, d driver) *sql.DB {
	t.Helper()
	db := openFile(t, d)
	if err := MigrateLibrary(t.Context(), db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return db
}

// execScript runs a testdata script whose statements end with ";" and a
// blank line.
func execScript(t *testing.T, db *sql.DB, name string) {
	t.Helper()
	body, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	for _, stmt := range strings.Split(string(body), ";\n\n") {
		if stmt = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(stmt), ";")); stmt == "" {
			continue
		}
		mustExec(t, db, stmt)
	}
}

func mustExec(t *testing.T, db *sql.DB, q string, args ...any) {
	t.Helper()
	if _, err := db.ExecContext(t.Context(), q, args...); err != nil {
		t.Fatalf("exec %q: %v", firstLine(q), err)
	}
}

func queryInt(t *testing.T, db *sql.DB, q string, args ...any) int {
	t.Helper()
	var n int
	if err := db.QueryRowContext(t.Context(), q, args...).Scan(&n); err != nil {
		t.Fatalf("query %q: %v", firstLine(q), err)
	}
	return n
}

func queryStrings(t *testing.T, db *sql.DB, q string, args ...any) []string {
	t.Helper()
	out, err := stringColumn(t.Context(), db, q, args...)
	if err != nil {
		t.Fatalf("query %q: %v", firstLine(q), err)
	}
	return out
}

// dumpSchema renders sqlite_master the way testdata/*.schema.sql was taken
// from the published files: every object in (type, name) order with the
// statement SQLite stores for it.
func dumpSchema(t *testing.T, db *sql.DB) string {
	t.Helper()
	rows, err := db.QueryContext(t.Context(),
		`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name`)
	if err != nil {
		t.Fatalf("read sqlite_master: %v", err)
	}
	defer rows.Close()
	var b strings.Builder
	for rows.Next() {
		var (
			typ, name, tbl string
			stmt           sql.NullString
		)
		if err := rows.Scan(&typ, &name, &tbl, &stmt); err != nil {
			t.Fatalf("scan sqlite_master: %v", err)
		}
		fmt.Fprintf(&b, "-- %s %s on %s\n", typ, name, tbl)
		if stmt.Valid {
			fmt.Fprintf(&b, "%s;\n", stmt.String)
		}
		b.WriteString("\n")
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read sqlite_master: %v", err)
	}
	return b.String()
}

// assertPublishedSchema fails with the first differing line when a database's
// schema is not the one in a testdata fixture.
func assertPublishedSchema(t *testing.T, db *sql.DB, fixture string) {
	t.Helper()
	want, err := os.ReadFile(filepath.Join("testdata", fixture))
	if err != nil {
		t.Fatalf("read %s: %v", fixture, err)
	}
	got := dumpSchema(t, db)
	if got == string(want) {
		return
	}
	gl, wl := strings.Split(got, "\n"), strings.Split(string(want), "\n")
	for i := 0; i < max(len(gl), len(wl)); i++ {
		var g, w string
		if i < len(gl) {
			g = gl[i]
		}
		if i < len(wl) {
			w = wl[i]
		}
		if g != w {
			t.Fatalf("schema differs from %s at line %d:\n got: %q\nwant: %q", fixture, i+1, g, w)
		}
	}
}
