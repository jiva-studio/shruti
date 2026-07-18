package sqlitepending

import (
	"context"
	"database/sql"
	"fmt"

	_ "github.com/mattn/go-sqlite3"

	pendingport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/pending"
)

// Verifier implements pendingport.Verifier: it opens a freshly-downloaded
// candidate pending.db and confirms it is a well-formed artifact (a readable
// SQLite file carrying a queryable `pending` table) before refresh swaps it
// in — the pending-side analogue of the catalog SchemeReader check.
type Verifier struct{}

func NewVerifier() Verifier { return Verifier{} }

func (Verifier) VerifyArtifact(ctx context.Context, dbPath string) error {
	db, err := sql.Open("sqlite3", fmt.Sprintf("file:%s?mode=ro&immutable=1", dbPath))
	if err != nil {
		return fmt.Errorf("open candidate pending.db: %w", err)
	}
	defer db.Close()
	if err := db.PingContext(ctx); err != nil {
		return fmt.Errorf("ping candidate pending.db: %w", err)
	}
	// A count query both proves the table exists and that it is a valid SQLite
	// file (a truncated / HTML-error download fails to parse here).
	var n int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM pending`).Scan(&n); err != nil {
		return fmt.Errorf("pending artifact missing/unreadable `pending` table: %w", err)
	}
	return nil
}

var _ pendingport.Verifier = (*Verifier)(nil)
