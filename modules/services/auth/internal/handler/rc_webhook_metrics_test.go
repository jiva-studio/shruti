package handler

import (
	"bufio"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/jiva-studio/shruti/auth/internal/application/rcsync"
)

// scrapeUnmatched reads shruti_rc_webhook_unmatched_total from what /metrics
// serves; -1 when the series is absent.
func scrapeUnmatched(t *testing.T) float64 {
	t.Helper()
	rec := httptest.NewRecorder()
	promhttp.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	sc := bufio.NewScanner(rec.Body)
	for sc.Scan() {
		value, ok := strings.CutPrefix(sc.Text(), "shruti_rc_webhook_unmatched_total ")
		if !ok {
			continue
		}
		v, err := strconv.ParseFloat(value, 64)
		if err != nil {
			t.Fatalf("parse sample %q: %v", value, err)
		}
		return v
	}
	return -1
}

// The rc_webhook_unmatched_high alert reads shruti_rc_webhook_unmatched_total:
// it rises by one per Unmatched answer and never on any other outcome.
func TestRCWebhookCountsOnlyUnmatchedDeliveries(t *testing.T) {
	for _, o := range []rcsync.Outcome{
		rcsync.Processed, rcsync.Duplicate, rcsync.Deferred, rcsync.Unresolvable,
		rcsync.NoAppUserID, rcsync.RCUnavailable, rcsync.Unmatched,
		rcsync.DeferFailed, rcsync.RecordFailed, rcsync.ApplyFailed,
	} {
		before := scrapeUnmatched(t)
		if before < 0 {
			t.Fatal("shruti_rc_webhook_unmatched_total is not served on /metrics")
		}
		h := &RCWebhookHandler{SecretPrimary: "s", Deliveries: &stubDeliveries{outcome: o}}
		h.ServeHTTP(httptest.NewRecorder(), mkRequest(t, "s", map[string]any{
			"event": map[string]any{"id": "evt_count", "app_user_id": "u", "environment": "PRODUCTION"},
		}))
		want := 0.0
		if o == rcsync.Unmatched {
			want = 1
		}
		if got := scrapeUnmatched(t) - before; got != want {
			t.Errorf("outcome %d: counter rose by %v, want %v", o, got, want)
		}
	}
}
