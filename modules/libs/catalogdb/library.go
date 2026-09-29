package catalogdb

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// MigrateLibrary brings a library.db up to the published schema: an empty file
// gets the baseline, an older one each step whose effect it lacks, each in its
// own transaction. library.db carries no migrations table, so every step is
// detected from the schema itself. Run it once when the file is opened for
// writing.
func MigrateLibrary(ctx context.Context, db *sql.DB) error {
	return libraryPlan.migrate(ctx, db)
}

var libraryPlan = plan{
	format:   "library",
	baseline: libraryBaseline,
	steps: []Step{
		{Name: "rename_attribution_texts", Needed: needsTriggersRename, Up: renameAttributionTexts},
		{Name: "add_attribution_tables", Needed: lacksAttributionTables, Up: addAttributionTables},
		{Name: "relax_attribution_ref_kind", Needed: refKindIsChecked, Up: relaxAttributionRefKind},
		{Name: "add_attribution_ref_language", Needed: lacksRefLanguage, Up: addAttributionRefLanguage},
		{Name: "rebuild_attribution_kinds", Needed: attributionKindsAreOld, ForeignKeysOff: true, Up: rebuildAttributionKinds},
		{Name: "add_media", Needed: lacksMedia, Up: addMedia},
	},
}

func needsTriggersRename(ctx context.Context, q Querier) (bool, error) {
	return tableExists(ctx, q, "library_attribution_texts")
}

// renameAttributionTexts gives the attribution search phrases their current
// name. Nothing references the table, so a plain rename keeps every row.
func renameAttributionTexts(ctx context.Context, tx *sql.Tx) error {
	return execAll(ctx, tx, `ALTER TABLE library_attribution_texts RENAME TO library_attribution_triggers`)
}

var attributionTables = []struct{ name, ddl string }{
	{"library_attributions", ddlLibraryTableLibraryAttributions},
	{"library_attribution_triggers", ddlLibraryTableLibraryAttributionTriggers},
	{"library_attribution_notes", ddlLibraryTableLibraryAttributionNotes},
	{"library_attribution_refs", ddlLibraryTableLibraryAttributionRefs},
}

func lacksAttributionTables(ctx context.Context, q Querier) (bool, error) {
	for _, t := range attributionTables {
		has, err := tableExists(ctx, q, t.name)
		if err != nil || !has {
			return !has, err
		}
	}
	for _, name := range []string{"library_attributions_by_kind", "library_attr_refs_by_target"} {
		has, err := indexExists(ctx, q, name)
		if err != nil || !has {
			return !has, err
		}
	}
	return false, nil
}

// addAttributionTables creates the curated attributions the chat research
// pipeline reads: an attribution, its search phrases per language, one note
// per language, and its references to verses, documents, titles and lecture
// fragments.
func addAttributionTables(ctx context.Context, tx *sql.Tx) error {
	for _, t := range attributionTables {
		if err := createTableIfMissing(ctx, tx, t.name, t.ddl); err != nil {
			return err
		}
	}
	if err := createIndexIfMissing(ctx, tx, ddlLibraryIndexLibraryAttributionsByKind); err != nil {
		return err
	}
	return createIndexIfMissing(ctx, tx, ddlLibraryIndexLibraryAttrRefsByTarget)
}

func refKindIsChecked(ctx context.Context, q Querier) (bool, error) {
	ddl, ok, err := tableSQL(ctx, q, "library_attribution_refs")
	return ok && strings.Contains(strings.ToUpper(ddl), "CHECK"), err
}

// relaxAttributionRefKind rebuilds the reference table without a CHECK on
// ref_kind: the kinds are validated in code, so a new kind needs no migration.
// SQLite cannot drop a CHECK in place.
func relaxAttributionRefKind(ctx context.Context, tx *sql.Tx) error {
	cols := "attribution_id, ref_kind, target_id, position"
	hasLanguage, err := columnExists(ctx, tx, "library_attribution_refs", "language")
	if err != nil {
		return err
	}
	if hasLanguage {
		cols += ", language"
	}
	return execAll(ctx, tx,
		renamedDDL(ddlLibraryTableLibraryAttributionRefs, "library_attribution_refs"),
		`INSERT INTO library_attribution_refs_new (`+cols+`) SELECT `+cols+` FROM library_attribution_refs`,
		`DROP TABLE library_attribution_refs`,
		`ALTER TABLE library_attribution_refs_new RENAME TO library_attribution_refs`,
		ddlLibraryIndexLibraryAttrRefsByTarget,
	)
}

func lacksRefLanguage(ctx context.Context, q Querier) (bool, error) {
	has, err := columnExists(ctx, q, "library_attribution_refs", "language")
	return !has, err
}

// addAttributionRefLanguage scopes a reference to one answer language; NULL
// means the reference holds in every language.
func addAttributionRefLanguage(ctx context.Context, tx *sql.Tx) error {
	return addColumnsIfMissing(ctx, tx, "library_attribution_refs", "language")
}

func attributionKindsAreOld(ctx context.Context, q Querier) (bool, error) {
	ddl, ok, err := tableSQL(ctx, q, "library_attributions")
	if err != nil || !ok {
		return false, err
	}
	if !strings.Contains(strings.ToUpper(ddl), "CHECK") {
		return false, nil
	}
	return strings.Contains(ddl, "'question'") || !strings.Contains(ddl, "'memory'"), nil
}

// rebuildAttributionKinds moves the kind CHECK to pinned | boost | memory,
// renaming question to pinned and topic to boost on the way. SQLite can neither
// alter a CHECK nor update a row to a value the old CHECK forbids, so the table
// is rebuilt; its children reference the unchanged id and survive the swap.
func rebuildAttributionKinds(ctx context.Context, tx *sql.Tx) error {
	return execAll(ctx, tx,
		renamedDDL(ddlLibraryTableLibraryAttributions, "library_attributions"),
		`INSERT INTO library_attributions_new (id, kind, created_at, updated_at)
		 SELECT id,
		        CASE kind WHEN 'question' THEN 'pinned' WHEN 'topic' THEN 'boost' ELSE kind END,
		        created_at, updated_at
		 FROM library_attributions`,
		`DROP TABLE library_attributions`,
		`ALTER TABLE library_attributions_new RENAME TO library_attributions`,
		ddlLibraryIndexLibraryAttributionsByKind,
	)
}

func lacksMedia(ctx context.Context, q Querier) (bool, error) {
	has, err := tableExists(ctx, q, "library_media")
	if err != nil || !has {
		return !has, err
	}
	idx, err := indexExists(ctx, q, "library_media_by_lang")
	return !idx, err
}

// addMedia adds the short media clips the chat indexer embeds: one row per
// clip per language.
func addMedia(ctx context.Context, tx *sql.Tx) error {
	return createTableIfMissing(ctx, tx, "library_media", ddlLibraryTableLibraryMedia,
		ddlLibraryIndexLibraryMediaByLang)
}

// renamedDDL turns a published CREATE TABLE into the one for its `_new`
// rebuild twin. Renaming the twin back makes SQLite store exactly the
// published text again.
func renamedDDL(ddl, table string) string {
	quoted := fmt.Sprintf(`CREATE TABLE "%s" (`, table)
	return strings.Replace(ddl, quoted, fmt.Sprintf(`CREATE TABLE %s_new (`, table), 1)
}

func indexExists(ctx context.Context, q Querier, name string) (bool, error) {
	var n int
	if err := q.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = ?`, name).Scan(&n); err != nil {
		return false, err
	}
	return n > 0, nil
}
