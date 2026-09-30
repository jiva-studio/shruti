package metrics_test

import (
	"bufio"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/jiva-studio/shruti/auth/internal/metrics"
	"github.com/jiva-studio/shruti/auth/internal/ports"
)

var _ ports.RevenueCatMetrics = metrics.RevenueCat{}

// scrape reads one unlabelled sample from what /metrics serves; -1 when the
// series is absent.
func scrape(t *testing.T, name string) float64 {
	t.Helper()
	rec := httptest.NewRecorder()
	promhttp.Handler().ServeHTTP(rec, httptest.NewRequest("GET", "/metrics", nil))
	sc := bufio.NewScanner(rec.Body)
	for sc.Scan() {
		value, ok := strings.CutPrefix(sc.Text(), name+" ")
		if !ok {
			continue
		}
		v, err := strconv.ParseFloat(value, 64)
		if err != nil {
			t.Fatalf("parse %s sample %q: %v", name, value, err)
		}
		return v
	}
	return -1
}

// The names are the ones the Grafana alert rules query.
func TestRevenueCatCountersOnMetricsEndpoint(t *testing.T) {
	m := metrics.RevenueCat{}
	for _, tc := range []struct {
		name string
		inc  func()
	}{
		{"rc_api_auth_failed_total", m.APIAuthFailed},
		{"rc_api_rate_limited_total", m.APIRateLimited},
		{"rc_api_permanent_total", m.APIPermanent},
		{"rc_webhook_permanent_unresolved_total", m.WebhookPermanentUnresolved},
		{"shruti_rc_webhook_unmatched_total", m.WebhookUnmatched},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := scrape(t, tc.name)
			if before < 0 {
				t.Fatalf("%s is not served on /metrics", tc.name)
			}
			tc.inc()
			if got := scrape(t, tc.name) - before; got != 1 {
				t.Fatalf("%s rose by %v after one event, want 1", tc.name, got)
			}
		})
	}
}
