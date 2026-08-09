package publish

import (
	"context"
	"database/sql"
	"fmt"

	_ "github.com/mattn/go-sqlite3"
)

// checkpointWAL folds the write-ahead log back into the database file.
//
// Publish uploads current.db as bytes. The catalog is opened in WAL mode, so a
// write lands in current.db-wal first and only reaches the file itself when
// SQLite decides to checkpoint — by default after about a thousand pages.
// Anything still in the log at upload time is simply absent from the published
// catalog, and nothing complains: the run reports success and the right byte
// count, having shipped the previous state.
//
// That is not hypothetical. A publish carrying 248 rewritten collection names
// and descriptions went out reporting 48 MB uploaded and delivered none of
// them; the same run's outlines survived only because there were enough of them
// to trip the automatic checkpoint.
//
// TRUNCATE (rather than PASSIVE) blocks until the log is fully applied, which
// is the point — a partial fold would ship a partial catalog.
func checkpointWAL(ctx context.Context, path string) error {
	db, err := sql.Open("sqlite3", fmt.Sprintf("file:%s?_busy_timeout=60000", path))
	if err != nil {
		return fmt.Errorf("checkpoint: open %s: %w", path, err)
	}
	defer db.Close()

	var busy, logPages, moved int
	if err := db.QueryRowContext(ctx, "PRAGMA wal_checkpoint(TRUNCATE)").
		Scan(&busy, &logPages, &moved); err != nil {
		return fmt.Errorf("checkpoint %s: %w", path, err)
	}
	// busy=1 means a reader held the log open and it was not fully applied —
	// publishing now would ship an incomplete catalog.
	if busy != 0 {
		return fmt.Errorf("checkpoint %s: blocked by an open reader (%d pages left)", path, logPages)
	}
	return nil
}
