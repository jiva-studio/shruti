// Package handler wires HTTP routes for the billing service.
package handler

import (
	"net/http"
	"os"

	"github.com/go-chi/chi/v5"

	"github.com/akdasa-studios/shruti/billing/internal/driver"
	"github.com/akdasa-studios/shruti/billing/internal/jwtverify"
	"github.com/akdasa-studios/shruti/billing/internal/paymento"
	"github.com/akdasa-studios/shruti/billing/internal/store"
)

// BillingHandler holds the dependencies every billing route needs. HMACSecret
// empty → the webhook returns 503; an unconfigured Paymento client → checkout
// returns 503. The service still boots in both cases.
type BillingHandler struct {
	Repo          *store.Repo
	Verifier      *jwtverify.Verifier
	Paymento      *paymento.Client
	Driver        *driver.Driver
	PublicBaseURL string
	HMACSecret    string

	checkoutLimiter *tokenBucket
}

// NewRouter wires every billing route. If h is nil only /billing/healthz is
// served (boot probe before deps are wired).
func NewRouter(h *BillingHandler) http.Handler {
	r := chi.NewRouter()
	r.Use(requestLogger)

	r.Get("/billing/healthz", healthz)

	if h == nil {
		return r
	}
	if h.checkoutLimiter == nil {
		// ~5 checkout attempts burst, refilling 1 per 12s (5/min sustained).
		h.checkoutLimiter = newTokenBucket(5, 1.0/12.0)
	}

	r.Post("/billing/checkout", h.checkout)
	r.Post("/webhooks/paymento", h.paymentoWebhook)
	return r
}

var (
	buildSHA  = os.Getenv("SHRUTI_BUILD_SHA")
	buildTime = os.Getenv("SHRUTI_BUILD_TIME")
)

func healthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"status": "ok",
		"build": map[string]string{
			"sha":  buildSHA,
			"time": buildTime,
		},
	})
}
