// Package metrics serves the RevenueCat counters on the default Prometheus
// registry, which the router exposes on /metrics. The names are the ones the
// Grafana alert rules query.
package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	apiAuthFailed = promauto.NewCounter(prometheus.CounterOpts{
		Name: "rc_api_auth_failed_total",
		Help: "RevenueCat REST calls answered 401 or 403: the API key is wrong or revoked.",
	})
	apiRateLimited = promauto.NewCounter(prometheus.CounterOpts{
		Name: "rc_api_rate_limited_total",
		Help: "RevenueCat REST calls answered 429.",
	})
	apiPermanent = promauto.NewCounter(prometheus.CounterOpts{
		Name: "rc_api_permanent_total",
		Help: "RevenueCat REST calls answered with a permanent 4xx.",
	})
	webhookPermanentUnresolved = promauto.NewCounter(prometheus.CounterOpts{
		Name: "rc_webhook_permanent_unresolved_total",
		Help: "RevenueCat webhook deliveries left unprocessed because the refetch failed permanently.",
	})
	webhookUnmatched = promauto.NewCounter(prometheus.CounterOpts{
		Name: "shruti_rc_webhook_unmatched_total",
		Help: "RevenueCat webhook events whose customer was not bound to a user when first delivered.",
	})
)

// RevenueCat reports RevenueCat outcomes as Prometheus counters.
type RevenueCat struct{}

func (RevenueCat) APIAuthFailed()              { apiAuthFailed.Inc() }
func (RevenueCat) APIRateLimited()             { apiRateLimited.Inc() }
func (RevenueCat) APIPermanent()               { apiPermanent.Inc() }
func (RevenueCat) WebhookPermanentUnresolved() { webhookPermanentUnresolved.Inc() }
func (RevenueCat) WebhookUnmatched()           { webhookUnmatched.Inc() }
