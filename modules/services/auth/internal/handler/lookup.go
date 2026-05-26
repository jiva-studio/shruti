package handler

import (
	"encoding/json"
	"net/http"
	"regexp"
)

// POST /auth/lookup
//
// Existence probe — no side effects, no tokens. Mobile uses it during
// the retry-other-region flow (PR-3) to ask the OTHER region's auth
// service whether a user already lives there before bouncing the
// signin elsewhere.
//
// Body shape:
//
//	{"provider": "google" | "apple" | "device", "subject": "<oauth-sub>"}
//
// Response on match: {"exists": true,  "anonymous": <bool>}
// Response on miss:  {"exists": false}
//
// Privacy note: the body carries the raw OAuth subject (not a hash).
// The caller already possesses that subject — they minted a token
// for it from the provider — so leaking it back across regions is
// not a new exposure. The endpoint is rate-limited at Caddy with
// the same policy as /auth/signin/*.

var (
	lookupProviders = map[string]bool{
		"google": true,
		"apple":  true,
		"device": true,
	}
	// Subject formats vary by provider (Apple returns a 76-ish-char
	// hex+dots, Google a numeric id, device a UUID). A liberal regex
	// keeps the validation focused on "not obviously garbage" —
	// rejecting too-long inputs that could be a probe vector.
	lookupSubjectRe = regexp.MustCompile(`^[A-Za-z0-9._:\-]{1,128}$`)
)

type lookupReq struct {
	Provider string `json:"provider"`
	Subject  string `json:"subject"`
}

type lookupResp struct {
	Exists    bool `json:"exists"`
	Anonymous bool `json:"anonymous,omitempty"`
}

func (h *authHandler) lookup(w http.ResponseWriter, r *http.Request) {
	var body lookupReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if !lookupProviders[body.Provider] {
		writeErr(w, http.StatusBadRequest, "bad_provider",
			"provider must be google, apple, or device")
		return
	}
	if !lookupSubjectRe.MatchString(body.Subject) {
		writeErr(w, http.StatusBadRequest, "bad_subject",
			"subject must be 1..128 chars of [A-Za-z0-9._:-]")
		return
	}
	res, err := h.svc.FindUserByProviderSubject(r.Context(), body.Provider, body.Subject)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "lookup_failed", err.Error())
		return
	}
	if !res.Exists {
		writeJSON(w, http.StatusOK, lookupResp{Exists: false})
		return
	}
	writeJSON(w, http.StatusOK, lookupResp{Exists: true, Anonymous: res.Anonymous})
}
