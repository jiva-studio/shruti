package handler

import (
	"net/http"
)

// GET /whoami
//
// Returns a coarse country hint for the caller's IP. Used by mobile's
// Welcome auto-detect (PR-3) as the WEAKEST of three home-region
// signals — timezone and device locale fire first and are not
// VPN-defeatable in the same way. The endpoint is intentionally
// public (no bearer) so first-launch detection works before any
// session exists.
//
// MVP shape: returns {"country": ""} unconditionally. The two real
// data sources we considered are:
//
//   - ip-api.com free tier (no key, 45 req/min/IP at edge): would
//     pull a 2-letter country code from X-Forwarded-For with a
//     ~50ms p95. Trade: a third-party external dep on every cold
//     launch.
//   - MaxMind GeoLite2 local DB: zero external dep but adds a
//     ~70MB binary blob to the auth container image + a refresh
//     cron.
//
// Until the Russia VPS is actually deployed (PR-4 still draft as of
// 2026-05-26), every install hits the same single global region and
// the country signal can't change routing. Shipping the GeoIP
// integration now would be dead weight; mobile's TZ + lang signals
// cover ≥95% of real users.
//
// TODO(pr-4): wire ip-api.com (or MaxMind) once the Russia VPS is
// up. clientIP() in middleware.go already resolves the right hop;
// the handler just needs an LRU-cached GeoIP lookup and an env-var
// switch.
func (h *authHandler) whoami(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"country": ""})
}
