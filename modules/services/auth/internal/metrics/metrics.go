// Package metrics holds process-level counters for the auth service.
//
// The auth binary doesn't yet wire a Prometheus client (most signals are
// DB-derived gauges scraped by postgres-exporter, see
// infra/observability-agent/compose/postgres-queries.yaml). Counters in
// this package are exposed via the standard-library `expvar` registry —
// zero added dependencies — and named to match the Prometheus metric
// names the alerts in `infra/observability/.../alerting/rules.yml`
// reference. A future Prometheus shim (or expvar→prom bridge) can scrape
// `/debug/vars` and translate; the API of these counters does not need
// to change at that point.
//
// All counters are safe for concurrent use.
package metrics

import (
	"expvar"
	"sync/atomic"
)

// Counter is a thread-safe monotonic counter. The zero value is ready
// to use; calling Inc before any other access is fine.
type Counter struct {
	v atomic.Int64
}

// Inc bumps the counter by 1.
func (c *Counter) Inc() { c.v.Add(1) }

// Add bumps the counter by n. Negative values are accepted but a counter
// in the Prometheus sense should only ever grow — callers should not pass
// negative values.
func (c *Counter) Add(n int64) { c.v.Add(n) }

// Value returns the current count. Mostly useful in tests.
func (c *Counter) Value() int64 { return c.v.Load() }

// register attaches a counter to `expvar` under the given name. expvar
// panics on duplicate registration; we wrap it in a sync.Once-like
// idempotent helper so package init stays clean if anyone ever inits
// the package twice (test harness, reload).
func register(name string, c *Counter) {
	expvar.Publish(name, expvar.Func(func() any { return c.Value() }))
}

// RCAPIAuthFailedTotal counts RevenueCat REST calls that returned 401 or
// 403. Non-zero is operator-actionable: the RC API key is misconfigured
// or revoked, every cron tick and every webhook will keep burning a
// fresh failure. Alert page in observability rules.yml.
var RCAPIAuthFailedTotal = &Counter{}

// RCAPIRateLimitedTotal counts RevenueCat REST calls that returned 429.
// Steady-state non-zero means we're hitting RC's per-key throttle —
// usually a runaway reconcile loop or an outage backlog working through.
var RCAPIRateLimitedTotal = &Counter{}

// RCAPIPermanentTotal is the umbrella counter for all permanent 4xx
// outcomes (currently 401/403; 404 is a soft success). Lets a single
// PromQL graph track "calls RC has told us to stop making".
var RCAPIPermanentTotal = &Counter{}

func init() {
	register("rc_api_auth_failed_total", RCAPIAuthFailedTotal)
	register("rc_api_rate_limited_total", RCAPIRateLimitedTotal)
	register("rc_api_permanent_total", RCAPIPermanentTotal)
}
