package search

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
)

type recordingTx struct {
	pgx.Tx
	rolledBack  bool
	rollbackErr error
}

func (tx *recordingTx) Rollback(ctx context.Context) error {
	tx.rolledBack = true
	tx.rollbackErr = ctx.Err()
	return tx.rollbackErr
}

// A request cancelled after its rows were read still ends its transaction
// cleanly: pgx fails a rollback on a done context and drops the connection.
func TestEndReadTxRollsBackAfterTheRequestIsCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	tx := &recordingTx{}

	endReadTx(ctx, tx)

	if !tx.rolledBack {
		t.Fatal("the read transaction was not rolled back")
	}
	if tx.rollbackErr != nil {
		t.Fatalf("rollback ran on a done context: %v", tx.rollbackErr)
	}
}
