// Package redislimit is the Redis-backed daily-quota counter for
// share-video renders. Replaces the legacy public.usage Postgres table.
//
// Atomic INCR + EXPIRE via Lua: a crash between the two operations
// would leave the key without a TTL and lock the user out across days.
// Keys are `rl:share_video:user:{id}:{YYYYMMDD}`, TTL is
// seconds-to-next-UTC-midnight + a full-day buffer, plus ±300s jitter
// to spread out the midnight expiry burst.
package redislimit

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const usageScope = "share_video"

type UsageResult struct {
	Count   int
	Limit   int
	Allowed bool
}

// incrWithTTL is the atomic counter primitive.
// KEYS[1]=key, ARGV[1]=ttl_seconds, ARGV[2]=jitter_seconds. Returns the
// new counter value.
var incrWithTTL = redis.NewScript(`
local count = redis.call('INCR', KEYS[1])
if redis.call('TTL', KEYS[1]) == -1 then
  local ttl = tonumber(ARGV[1])
  local jitter = tonumber(ARGV[2])
  redis.call('EXPIRE', KEYS[1], ttl + math.random(-jitter, jitter))
end
return count
`)

const jitterSeconds = 300

func secondsUntilNextMidnightUTC(now time.Time) int {
	n := now.UTC()
	return 86400 - (n.Hour()*3600 + n.Minute()*60 + n.Second())
}

// IncrementAndCheck atomically increments the per-user daily counter
// and returns whether the request fits under the configured limit.
// Same semantics as the previous postgres implementation: increments
// BEFORE deciding, so a concurrent burst can let N-1 requests slip
// past the cap (by-design — burst is small, abuse is bounded by Caddy
// edge rate-limits).
func IncrementAndCheck(ctx context.Context, rdb *redis.Client, userID string, anonymous bool, anonLimit, signedLimit int) (UsageResult, error) {
	limit := signedLimit
	if anonymous {
		limit = anonLimit
	}
	now := time.Now().UTC()
	key := fmt.Sprintf("rl:%s:user:%s:%s", usageScope, userID, now.Format("20060102"))
	ttl := secondsUntilNextMidnightUTC(now) + 86400
	raw, err := incrWithTTL.Run(ctx, rdb, []string{key}, ttl, jitterSeconds).Int()
	if err != nil {
		return UsageResult{}, fmt.Errorf("redis incr: %w", err)
	}
	return UsageResult{Count: raw, Limit: limit, Allowed: raw <= limit}, nil
}
