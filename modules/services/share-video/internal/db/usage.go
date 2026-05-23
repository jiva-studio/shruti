package db

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

// UsageScope is the prefix in public.usage.key under which share-video
// counts daily renders. Chat uses its own prefix in the same table.
const UsageScope = "share_video"

type UsageResult struct {
	Count   int
	Limit   int
	Allowed bool
}

// IncrementAndCheck atomically increments the per-user daily counter
// and returns whether the request fits under the configured limit.
//
// Day boundary is computed server-side as (now() AT TIME ZONE 'UTC')::date
// — keeps the bucket consistent regardless of container clock skew, and
// matches the chat service's usage of the same table.
//
// Increments BEFORE deciding to reject — this matches the existing
// Node implementation, where a concurrent burst can let N-1 requests
// slip past the cap. Treating it as by-design (the burst is small,
// the abuse surface is bounded by Caddy edge rate-limits).
func IncrementAndCheck(ctx context.Context, pool *pgxpool.Pool, userID string, anonymous bool, anonLimit, signedLimit int) (UsageResult, error) {
	limit := signedLimit
	if anonymous {
		limit = anonLimit
	}
	key := UsageScope + ":user:" + userID
	var count int
	err := pool.QueryRow(ctx,
		`INSERT INTO usage (key, day, count)
		 VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 1)
		 ON CONFLICT (key, day) DO UPDATE
		    SET count = usage.count + 1
		 RETURNING count`,
		key,
	).Scan(&count)
	if err != nil {
		return UsageResult{}, err
	}
	return UsageResult{Count: count, Limit: limit, Allowed: count <= limit}, nil
}
