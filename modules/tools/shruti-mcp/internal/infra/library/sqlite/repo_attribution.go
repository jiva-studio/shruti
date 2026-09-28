package sqlitelibrary

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jiva-studio/shruti/catalogdb"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/library"
)

// ---------- ATTRIBUTION ----------

// AttributionCreate inserts a new attribution row plus the first text
// variant in `language`. Caller mints the ID externally (usecase layer
// owns the canonical_<nanoid> prefix policy).
func (r *Repo) AttributionCreate(ctx context.Context, id string, kind library.AttributionKind, language, firstText string) error {
	if id == "" || kind == "" || language == "" || firstText == "" {
		return fmt.Errorf("attribution create: id, kind, language, text required")
	}
	now := time.Now().UTC().Format(time.RFC3339)
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO library_attributions (id, kind, created_at, updated_at) VALUES (?,?,?,?)`,
		id, string(kind), now, now); err != nil {
		return fmt.Errorf("insert attribution: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO library_attribution_triggers (attribution_id, language, text) VALUES (?,?,?)`,
		id, language, firstText); err != nil {
		return fmt.Errorf("insert first text: %w", err)
	}
	return tx.Commit()
}

// AttributionFindByText returns the id of an attribution of the given kind
// that already has an exact (language, text) variant, or ("", false) if none.
// Used to make Create idempotent: re-running a bulk import (or a single
// create) with the same text reuses the existing attribution instead of
// minting a duplicate — the server is the source of truth, no external
// checkpoint needed. Match is exact (case- and whitespace-sensitive), the
// same dedup contract the YAML importer used.
func (r *Repo) AttributionFindByText(ctx context.Context, kind library.AttributionKind, language, text string) (string, bool, error) {
	var id string
	err := r.db.QueryRowContext(ctx,
		`SELECT a.id
		   FROM library_attributions a
		   JOIN library_attribution_triggers t ON t.attribution_id = a.id
		  WHERE a.kind = ? AND t.language = ? AND t.text = ?
		  LIMIT 1`,
		string(kind), language, text,
	).Scan(&id)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return id, true, nil
}

// AttributionGet loads a full Attribution by id: phrases, notes and refs.
func (r *Repo) AttributionGet(ctx context.Context, id string) (library.Attribution, bool, error) {
	a, ok, err := catalogdb.AttributionByID(ctx, r.db, id)
	if err != nil || !ok {
		return library.Attribution{}, false, err
	}
	var refs []library.AttributionRef
	for _, ref := range a.Refs {
		refs = append(refs, library.AttributionRef{Kind: ref.Kind, TargetID: ref.TargetID, Language: ref.Language, Position: ref.Position})
	}
	return library.Attribution{
		ID:        a.ID,
		Kind:      library.AttributionKind(a.Kind),
		Texts:     a.Triggers,
		Notes:     a.Notes,
		Refs:      refs,
		CreatedAt: a.CreatedAt,
		UpdatedAt: a.UpdatedAt,
	}, true, nil
}

// AttributionList returns attribution metadata (without texts/refs to keep
// list responses slim — caller fetches full objects via Get if needed).
// `opts.Query` does a LIKE substring match against text variants.
func (r *Repo) AttributionList(ctx context.Context, opts library.ListAttributionsOpts) ([]library.Attribution, error) {
	limit := opts.Limit
	if limit <= 0 || limit > 500 {
		limit = 50
	}

	var (
		q    strings.Builder
		args []any
	)
	q.WriteString(`SELECT DISTINCT a.id, a.kind, a.created_at, a.updated_at FROM library_attributions a`)
	if opts.Query != "" {
		q.WriteString(` JOIN library_attribution_triggers t ON t.attribution_id = a.id`)
	}
	q.WriteString(` WHERE 1=1`)
	if opts.Kind != "" {
		q.WriteString(` AND a.kind = ?`)
		args = append(args, string(opts.Kind))
	}
	if opts.Query != "" {
		q.WriteString(` AND t.text LIKE ? ESCAPE '\'`)
		args = append(args, "%"+escapeLikeAny(opts.Query)+"%")
		if opts.Language != "" {
			q.WriteString(` AND t.language = ?`)
			args = append(args, opts.Language)
		}
	}
	if opts.Cursor != "" {
		q.WriteString(` AND a.id > ?`)
		args = append(args, opts.Cursor)
	}
	q.WriteString(` ORDER BY a.id LIMIT ?`)
	args = append(args, limit)

	rows, err := r.db.QueryContext(ctx, q.String(), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []library.Attribution
	for rows.Next() {
		var a library.Attribution
		var kind string
		if err := rows.Scan(&a.ID, &kind, &a.CreatedAt, &a.UpdatedAt); err != nil {
			return nil, err
		}
		a.Kind = library.AttributionKind(kind)
		out = append(out, a)
	}
	return out, rows.Err()
}

// AttributionTextAdd appends one text variant for the (id, language) pair.
// Duplicate (id, language, text) triple → PK conflict treated as no-op.
func (r *Repo) AttributionTextAdd(ctx context.Context, id, language, text string) error {
	if id == "" || language == "" || text == "" {
		return fmt.Errorf("text_add: id, language, text required")
	}
	if err := r.requireAttribution(ctx, id); err != nil {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		`INSERT OR IGNORE INTO library_attribution_triggers (attribution_id, language, text) VALUES (?,?,?)`,
		id, language, text); err != nil {
		return fmt.Errorf("insert text: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE library_attributions SET updated_at = ? WHERE id = ?`, now, id); err != nil {
		return fmt.Errorf("bump updated_at: %w", err)
	}
	return tx.Commit()
}

// AttributionTextRemove deletes one specific text variant. No-op if absent.
func (r *Repo) AttributionTextRemove(ctx context.Context, id, language, text string) error {
	if err := r.requireAttribution(ctx, id); err != nil {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM library_attribution_triggers WHERE attribution_id = ? AND language = ? AND text = ?`,
		id, language, text); err != nil {
		return fmt.Errorf("delete text: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE library_attributions SET updated_at = ? WHERE id = ?`, now, id); err != nil {
		return fmt.Errorf("bump updated_at: %w", err)
	}
	return tx.Commit()
}

// AttributionNoteSet upserts the single note for (id, language). One note per
// language — re-setting replaces it.
func (r *Repo) AttributionNoteSet(ctx context.Context, id, language, note string) error {
	if id == "" || language == "" || note == "" {
		return fmt.Errorf("note_set: id, language, note required")
	}
	if err := r.requireAttribution(ctx, id); err != nil {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		`INSERT INTO library_attribution_notes (attribution_id, language, note) VALUES (?,?,?)
		 ON CONFLICT(attribution_id, language) DO UPDATE SET note = excluded.note`,
		id, language, note); err != nil {
		return fmt.Errorf("upsert note: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE library_attributions SET updated_at = ? WHERE id = ?`, now, id); err != nil {
		return fmt.Errorf("bump updated_at: %w", err)
	}
	return tx.Commit()
}

// AttributionNoteRemove deletes the note for (id, language). No-op if absent.
func (r *Repo) AttributionNoteRemove(ctx context.Context, id, language string) error {
	if err := r.requireAttribution(ctx, id); err != nil {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM library_attribution_notes WHERE attribution_id = ? AND language = ?`,
		id, language); err != nil {
		return fmt.Errorf("delete note: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE library_attributions SET updated_at = ? WHERE id = ?`, now, id); err != nil {
		return fmt.Errorf("bump updated_at: %w", err)
	}
	return tx.Commit()
}

// AttributionDelete drops the attribution row; FK CASCADE removes texts/refs.
func (r *Repo) AttributionDelete(ctx context.Context, id string) error {
	res, err := r.db.ExecContext(ctx, `DELETE FROM library_attributions WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete attribution: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("delete attribution: %w", err)
	}
	if n == 0 {
		return ErrAttributionNotFound
	}
	return nil
}

// AttributionRefAdd validates that the referenced verse/document exists in
// this library, then inserts the ref. Cross-table FK is not enforceable in
// SQLite, so the application layer performs the existence check here.
func (r *Repo) AttributionRefAdd(ctx context.Context, id string, ref library.AttributionRef) error {
	if id == "" || ref.Kind == "" || ref.TargetID == "" {
		return fmt.Errorf("ref_add: id, kind, target_id required")
	}
	if err := r.requireAttribution(ctx, id); err != nil {
		return err
	}
	switch ref.Kind {
	case "verse":
		_, exists, err := r.GetVerseByID(ctx, ref.TargetID)
		if err != nil {
			return fmt.Errorf("verify verse: %w", err)
		}
		if !exists {
			return ErrRefTargetNotFound
		}
	case "document":
		_, exists, err := r.GetDocument(ctx, ref.TargetID)
		if err != nil {
			return fmt.Errorf("verify document: %w", err)
		}
		if !exists {
			return ErrRefTargetNotFound
		}
	case "title":
		// A title addresses a library_titles row (a chapter or canto heading)
		// in any language.
		target, err := catalogdb.ParseTitleTarget(ref.TargetID)
		if err != nil {
			return fmt.Errorf("ref_add: %w", err)
		}
		ref.TargetID = target.String()
		exists, err := r.titleExists(ctx, target.SourceID, target.Tokens)
		if err != nil {
			return fmt.Errorf("verify title: %w", err)
		}
		if !exists {
			return ErrRefTargetNotFound
		}
	case "track":
		// A track addresses a lecture fragment. Tracks live in the catalog,
		// not in library.db, so only the address is validated; the chat
		// service resolves it by transcript overlap.
		target, err := catalogdb.ParseTrackTarget(ref.TargetID)
		if err != nil {
			return fmt.Errorf("ref_add: %w", err)
		}
		ref.TargetID = target.String()
	default:
		return fmt.Errorf("ref_add: invalid kind %q (must be 'verse', 'document', 'title' or 'track')", ref.Kind)
	}
	now := time.Now().UTC().Format(time.RFC3339)
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var lang any
	if ref.Language != "" {
		lang = ref.Language
	}
	if _, err := tx.ExecContext(ctx,
		`INSERT OR IGNORE INTO library_attribution_refs (attribution_id, ref_kind, target_id, language, position) VALUES (?,?,?,?,?)`,
		id, ref.Kind, ref.TargetID, lang, ref.Position); err != nil {
		return fmt.Errorf("insert ref: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE library_attributions SET updated_at = ? WHERE id = ?`, now, id); err != nil {
		return fmt.Errorf("bump updated_at: %w", err)
	}
	return tx.Commit()
}

// AttributionRefRemove deletes by (attribution_id, ref_kind, target_id).
// No-op if absent.
func (r *Repo) AttributionRefRemove(ctx context.Context, id string, ref library.AttributionRef) error {
	if err := r.requireAttribution(ctx, id); err != nil {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM library_attribution_refs WHERE attribution_id = ? AND ref_kind = ? AND target_id IN (?, ?)`,
		id, ref.Kind, ref.TargetID, normalizedTarget(ref)); err != nil {
		return fmt.Errorf("delete ref: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE library_attributions SET updated_at = ? WHERE id = ?`, now, id); err != nil {
		return fmt.Errorf("bump updated_at: %w", err)
	}
	return tx.Commit()
}

// requireAttribution returns ErrAttributionNotFound unless the attribution
// exists.
func (r *Repo) requireAttribution(ctx context.Context, id string) error {
	var n int
	if err := r.db.QueryRowContext(ctx, `SELECT count(*) FROM library_attributions WHERE id = ?`, id).Scan(&n); err != nil {
		return fmt.Errorf("look up attribution %s: %w", id, err)
	}
	if n == 0 {
		return ErrAttributionNotFound
	}
	return nil
}

// titleExists reports whether a library_titles row exists for (source_id,
// tokens) in ANY language — a title ref addresses a chapter/canto, not a
// specific localization.
func (r *Repo) titleExists(ctx context.Context, sourceID, tokens string) (bool, error) {
	var n int
	if err := r.db.QueryRowContext(ctx,
		`SELECT count(*) FROM library_titles WHERE source_id = ? AND tokens = ?`,
		sourceID, tokens,
	).Scan(&n); err != nil {
		return false, err
	}
	return n > 0, nil
}

// escapeLikeAny escapes LIKE wildcards inside a substring pattern; the
// caller adds the leading/trailing '%' separately.
func escapeLikeAny(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}

// Sentinel errors. Application/MCP layer maps these to validation_failed /
// not_found envelope codes.
var (
	ErrAttributionNotFound = errors.New("attribution not found")
	ErrRefTargetNotFound   = errors.New("ref target (verse, document or title) not found in library")
)

// normalizedTarget is the form AttributionRefAdd stores a title or track
// target in; any other target, or one that does not parse, is returned as is.
func normalizedTarget(ref library.AttributionRef) string {
	switch ref.Kind {
	case "title":
		if t, err := catalogdb.ParseTitleTarget(ref.TargetID); err == nil {
			return t.String()
		}
	case "track":
		if t, err := catalogdb.ParseTrackTarget(ref.TargetID); err == nil {
			return t.String()
		}
	}
	return ref.TargetID
}
