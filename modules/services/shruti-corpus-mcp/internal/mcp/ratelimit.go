package mcpsrv

import (
	"context"
	"log"
	"strconv"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
	"github.com/redis/go-redis/v9"
)

// RateLimiter is a best-effort, per-client HOURLY cap on tool calls, backed by
// Redis so the counter survives a container redeploy — an in-memory bucket would
// reset on every Watchtower deploy and hand a runaway agent a fresh quota every
// couple of hours. Keyed on the same opaque client_hash we log (a hash of the
// IP), never a raw IP.
//
// A fixed 1-hour window (INCR + EXPIRE) rather than a token bucket: the abuse we
// catch is total VOLUME from one client — a hung agent re-issuing the same calls
// every ~10s for hours — which a volume cap bounds directly. A rate/burst
// limiter can't cap sustained volume without also clipping a legitimate client's
// short bursts (the real study agent peaks ~250 calls in one active hour, then
// goes quiet; the hung one grinds ~570/hour non-stop).
//
// Fail-OPEN on any Redis miss/error: a limiter outage must never take the
// read-only public MCP down.
type RateLimiter struct {
	perHour int
	// incr atomically increments the counter for `key` (a per-hash, per-hour
	// bucket) and returns its new value. Redis-backed in prod; a fake in tests.
	// nil ⇒ limiting disabled (fail-open).
	incr func(ctx context.Context, key string) (int64, error)
}

// NewRateLimiter dials the (optional) shared Redis and caps tool calls at
// perHour per client_hash. perHour <= 0 or an unreachable Redis disables it.
func NewRateLimiter(redisURL string, perHour int) *RateLimiter {
	rl := &RateLimiter{perHour: perHour}
	if perHour <= 0 {
		log.Printf("rate limit disabled (per-hour cap = %d)", perHour)
		return rl
	}
	rdb := dialRateLimit(redisURL)
	if rdb == nil {
		log.Printf("WARN rate limit disabled: Redis unavailable")
		return rl
	}
	log.Printf("rate limit active: %d tool calls/hour per client_hash", perHour)
	rl.incr = func(ctx context.Context, key string) (int64, error) {
		n, err := rdb.Incr(ctx, key).Result()
		if err == nil && n == 1 {
			// First hit of the window: expire a little past the hour so the key
			// self-cleans (and a small clock skew can't strand it).
			rdb.Expire(ctx, key, 70*time.Minute)
		}
		return n, err
	}
	return rl
}

func dialRateLimit(url string) *redis.Client {
	if url == "" {
		return nil
	}
	opt, err := redis.ParseURL(url)
	if err != nil {
		log.Printf("WARN rate limit disabled, bad REDIS_URL: %v", err)
		return nil
	}
	opt.DialTimeout = 500 * time.Millisecond
	opt.ReadTimeout = 300 * time.Millisecond
	opt.WriteTimeout = 300 * time.Millisecond
	rdb := redis.NewClient(opt)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := rdb.Ping(ctx).Err(); err != nil {
		log.Printf("WARN rate limit disabled, redis ping failed: %v", err)
		_ = rdb.Close()
		return nil
	}
	return rdb
}

// allow reports whether this client_hash is still under the hourly cap. A nil
// counter (disabled) or any counter error returns true (fail-open).
func (rl *RateLimiter) allow(ctx context.Context, clientHash string) bool {
	if rl.incr == nil || rl.perHour <= 0 {
		return true
	}
	hour := time.Now().Unix() / 3600
	key := "corpus-mcp:rl:" + clientHash + ":" + strconv.FormatInt(hour, 10)
	n, err := rl.incr(ctx, key)
	if err != nil {
		return true // fail-open: never block on a limiter fault
	}
	return n <= int64(rl.perHour)
}

// Middleware wraps every tool handler with the per-client hourly cap. Over the
// limit it returns a tool ERROR result (not a protocol error) so the client
// gets a clean "retry later" instead of a broken session. Non-tool traffic
// (initialize / tools-list / SSE / health) is untouched — only actual tool work
// is metered.
func (rl *RateLimiter) Middleware() server.ToolHandlerMiddleware {
	return func(next server.ToolHandlerFunc) server.ToolHandlerFunc {
		return func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			if !rl.allow(ctx, ClientHash(ctx)) {
				return mcp.NewToolResultError(
					"rate limit exceeded — too many requests this hour; please retry later",
				), nil
			}
			return next(ctx, req)
		}
	}
}
