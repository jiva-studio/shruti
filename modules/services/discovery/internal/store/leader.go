package store

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// leaderAdvisoryLockKey is held for the life of the process that crawls.
const leaderAdvisoryLockKey = 0x6469736C6472 // "disldr" bytes, fits int64

// Leader is a claim on being the one process that crawls.
//
// The service is not safe to run as two crawlers, and the reason is not the
// obvious one. Claiming work is a plain read with no row lock, so two replicas
// would take the same page — but that is the cheap half. The expensive half is
// that politeness lives in process memory: the per-host gap and the circuit
// breaker are a map in the fetcher, so two replicas are two limiters, each
// correctly observing an interval the other knows nothing about, and a site
// that asked for one request a second gets two. Locking the rows would not fix
// that; only shared limiter state would, which is a system of its own.
//
// So one process crawls. A replica that does not hold the lock still serves the
// whole HTTP API — it simply does not schedule. The lock is session-scoped, so
// a process that dies releases it and another takes over without anyone
// clearing a row.
//
// This governs the scheduler. Runs started by hand still fetch from whichever
// replica took the request, which is a deliberate limit: those are rare and
// somebody pressed a button to cause them.
type Leader struct {
	conn *pgxpool.Conn
}

// Lead tries to become the crawling process. It returns nil, nil when somebody
// else already is — not an error: a follower is a perfectly good replica.
func Lead(ctx context.Context, pool *pgxpool.Pool) (*Leader, error) {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return nil, fmt.Errorf("acquire: %w", err)
	}
	var got bool
	if err := conn.QueryRow(ctx,
		`SELECT pg_try_advisory_lock($1)`, int64(leaderAdvisoryLockKey)).Scan(&got); err != nil {
		conn.Release()
		return nil, fmt.Errorf("leader lock: %w", err)
	}
	if !got {
		conn.Release()
		return nil, nil
	}
	return &Leader{conn: conn}, nil
}

// Release gives up the claim. The connection is held for as long as the claim
// is, because a session advisory lock belongs to the session.
func (l *Leader) Release() {
	if l == nil || l.conn == nil {
		return
	}
	_, _ = l.conn.Exec(context.Background(), `SELECT pg_advisory_unlock($1)`, int64(leaderAdvisoryLockKey))
	l.conn.Release()
	l.conn = nil
}
