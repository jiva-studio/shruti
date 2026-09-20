package mcpsrv

import (
	"context"
	"sync"
	"testing"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

// fakeCounter is an in-memory stand-in for the Redis INCR, so the limiter's
// decision logic is testable without a Redis.
func fakeCounter() func(context.Context, string) (int64, error) {
	var mu sync.Mutex
	m := map[string]int64{}
	return func(_ context.Context, key string) (int64, error) {
		mu.Lock()
		defer mu.Unlock()
		m[key]++
		return m[key], nil
	}
}

func ctxWith(hash string) context.Context {
	return context.WithValue(context.Background(), clientHashKey, hash)
}

func TestRateLimiter_AllowsUpToCapThenBlocks(t *testing.T) {
	rl := &RateLimiter{perHour: 3, incr: fakeCounter()}
	ctx := ctxWith("clientA")
	// First 3 pass, the 4th+ are blocked (same hash, same hour).
	for i := 1; i <= 3; i++ {
		if !rl.allow(ctx, "clientA") {
			t.Fatalf("call %d should be allowed (cap 3)", i)
		}
	}
	if rl.allow(ctx, "clientA") {
		t.Fatal("4th call must be blocked")
	}
	if rl.allow(ctx, "clientA") {
		t.Fatal("5th call must stay blocked")
	}
}

func TestRateLimiter_PerClientBuckets(t *testing.T) {
	rl := &RateLimiter{perHour: 2, incr: fakeCounter()}
	// clientA exhausts its bucket…
	rl.allow(ctxWith("A"), "A")
	rl.allow(ctxWith("A"), "A")
	if rl.allow(ctxWith("A"), "A") {
		t.Fatal("A over cap should be blocked")
	}
	// …but clientB is independent.
	if !rl.allow(ctxWith("B"), "B") {
		t.Fatal("B must have its own bucket")
	}
}

func TestRateLimiter_DisabledAndFailOpen(t *testing.T) {
	// perHour <= 0 → disabled → always allow.
	off := &RateLimiter{perHour: 0, incr: fakeCounter()}
	for i := 0; i < 100; i++ {
		if !off.allow(ctxWith("x"), "x") {
			t.Fatal("disabled limiter must always allow")
		}
	}
	// nil counter (no Redis) → fail-open even with a positive cap.
	noRedis := &RateLimiter{perHour: 1, incr: nil}
	for i := 0; i < 100; i++ {
		if !noRedis.allow(ctxWith("x"), "x") {
			t.Fatal("nil counter must fail open")
		}
	}
	// counter error → fail-open.
	errLimiter := &RateLimiter{perHour: 1, incr: func(context.Context, string) (int64, error) {
		return 0, context.DeadlineExceeded
	}}
	if !errLimiter.allow(ctxWith("x"), "x") {
		t.Fatal("counter error must fail open")
	}
}

func TestRateLimiter_MiddlewareReturnsErrorOverLimit(t *testing.T) {
	rl := &RateLimiter{perHour: 1, incr: fakeCounter()}
	var called int
	next := server.ToolHandlerFunc(func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		called++
		return mcp.NewToolResultText("ok"), nil
	})
	wrapped := rl.Middleware()(next)

	ctx := ctxWith("agent")
	// 1st call → passes through to the handler.
	res, err := wrapped(ctx, mcp.CallToolRequest{})
	if err != nil || res == nil || res.IsError {
		t.Fatalf("first call should succeed, got res=%v err=%v", res, err)
	}
	if called != 1 {
		t.Fatalf("handler should have run once, ran %d", called)
	}
	// 2nd call → blocked with a tool error, handler NOT invoked again.
	res, err = wrapped(ctx, mcp.CallToolRequest{})
	if err != nil {
		t.Fatalf("blocked call should return a tool error result, not a protocol error: %v", err)
	}
	if res == nil || !res.IsError {
		t.Fatalf("blocked call must be a tool error result, got %v", res)
	}
	if called != 1 {
		t.Fatalf("handler must NOT run when rate limited, ran %d", called)
	}
}
