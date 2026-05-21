package sqlitelibrary

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/library"
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
		`INSERT INTO library_attribution_texts (attribution_id, language, text) VALUES (?,?,?)`,
		id, language, firstText); err != nil {
		return fmt.Errorf("insert first text: %w", err)
	}
	return tx.Commit()
}

// AttributionGet loads a full Attribution by id (texts + refs included).
func (r *Repo) AttributionGet(ctx context.Context, id string) (library.Attribution, bool, error) {
	var a library.Attribution
	var kind string
	row := r.db.QueryRowContext(ctx,
		`SELECT id, kind, created_at, updated_at FROM library_attributions WHERE id = ?`, id,
	)
	if err := row.Scan(&a.ID, &kind, &a.CreatedAt, &a.UpdatedAt); err != nil {
		if err == sql.ErrNoRows {
			return library.Attribution{}, false, nil
		}
		return library.Attribution{}, false, err
	}
	a.Kind = library.AttributionKind(kind)

	texts, err := r.readAttributionTexts(ctx, a.ID)
	if err != nil {
		return library.Attribution{}, false, err
	}
	a.Texts = texts

	refs, err := r.readAttributionRefs(ctx, a.ID)
	if err != nil {
		return library.Attribution{}, false, err
	}
	a.Refs = refs

	return a, true, nil
}

func (r *Repo) readAttributionTexts(ctx context.Context, attrID string) (map[string][]string, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT language, text FROM library_attribution_texts WHERE attribution_id = ? ORDER BY language, text`,
		attrID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string][]string)
	for rows.Next() {
		var lang, text string
		if err := rows.Scan(&lang, &text); err != nil {
			return nil, err
		}
		out[lang] = append(out[lang], text)
	}
	return out, rows.Err()
}

func (r *Repo) readAttributionRefs(ctx context.Context, attrID string) ([]library.AttributionRef, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT ref_kind, target_id, position FROM library_attribution_refs
		 WHERE attribution_id = ?
		 ORDER BY position, ref_kind, target_id`,
		attrID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []library.AttributionRef
	for rows.Next() {
		var ref library.AttributionRef
		if err := rows.Scan(&ref.Kind, &ref.TargetID, &ref.Position); err != nil {
			return nil, err
		}
		out = append(out, ref)
	}
	return out, rows.Err()
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
		q.WriteString(` JOIN library_attribution_texts t ON t.attribution_id = a.id`)
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
	if !r.attributionExists(ctx, id) {
		return ErrAttributionNotFound
	}
	now := time.Now().UTC().Format(time.RFC3339)
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		`INSERT OR IGNORE INTO library_attribution_texts (attribution_id, language, text) VALUES (?,?,?)`,
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
	if !r.attributionExists(ctx, id) {
		return ErrAttributionNotFound
	}
	now := time.Now().UTC().Format(time.RFC3339)
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM library_attribution_texts WHERE attribution_id = ? AND language = ? AND text = ?`,
		id, language, text); err != nil {
		return fmt.Errorf("delete text: %w", err)
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
	n, _ := res.RowsAffected()
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
	if !r.attributionExists(ctx, id) {
		return ErrAttributionNotFound
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
	default:
		return fmt.Errorf("ref_add: invalid kind %q (must be 'verse' or 'document')", ref.Kind)
	}
	now := time.Now().UTC().Format(time.RFC3339)
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		`INSERT OR IGNORE INTO library_attribution_refs (attribution_id, ref_kind, target_id, position) VALUES (?,?,?,?)`,
		id, ref.Kind, ref.TargetID, ref.Position); err != nil {
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
	if !r.attributionExists(ctx, id) {
		return ErrAttributionNotFound
	}
	now := time.Now().UTC().Format(time.RFC3339)
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM library_attribution_refs WHERE attribution_id = ? AND ref_kind = ? AND target_id = ?`,
		id, ref.Kind, ref.TargetID); err != nil {
		return fmt.Errorf("delete ref: %w", err)
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE library_attributions SET updated_at = ? WHERE id = ?`, now, id); err != nil {
		return fmt.Errorf("bump updated_at: %w", err)
	}
	return tx.Commit()
}

func (r *Repo) attributionExists(ctx context.Context, id string) bool {
	var n int
	_ = r.db.QueryRowContext(ctx, `SELECT count(*) FROM library_attributions WHERE id = ?`, id).Scan(&n)
	return n > 0
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
	ErrAttributionNotFound = fmt.Errorf("attribution not found")
	ErrRefTargetNotFound   = fmt.Errorf("ref target (verse or document) not found in library")
)
