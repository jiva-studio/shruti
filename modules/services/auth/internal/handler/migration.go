package handler

// Wave 4 / PR-2a — POST /auth/migrate-in and POST /auth/migrate-revoke.
//
// migrate-in:   accepts a bearer signed by ANY trusted region's kid;
//               rebuilds the user + identities on THIS region from the
//               claims; returns a fresh session signed with our kid.
// migrate-revoke: source-side handler. Bearer must be signed by
//               another region (i.e. the destination that completed
//               migrate-in). We delete the user row on this region,
//               cascading to identities + refresh_tokens; the existing
//               user.deleted outbox trigger drives downstream cleanup.
//
// Both endpoints use the existing multi-kid Verifier — the operator
// rsync's other regions' public keys into JWT_PUBLIC_KEYS_DIR (see
// curried-snacking-thunder.md Phase 4), and NewVerifierFromDir picks
// them up at boot. No per-handler trust list — kid trust is a property
// of the verifier dir, not a per-endpoint allowlist.

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"slices"

	"github.com/akdasa-studios/lectorium/auth/internal/jwt"
	"github.com/akdasa-studios/lectorium/auth/internal/service"
)

// migrateInReq carries the optional device id the migrating client
// wants the destination's refresh-token row stamped with. Mirrors the
// shape of /auth/anonymous so the mobile composition layer can reuse
// device-id plumbing on both flows.
type migrateInReq struct {
	DeviceID string `json:"deviceId,omitempty"`
}

// migrateIn handles POST /auth/migrate-in.
//
// 401 missing_bearer  / bad_bearer  — bearer absent or signature fails.
// 401 wrong_audience              — bearer is not an access token (aud != "chat").
// 400 anonymous_rejected          — claims carry only device identities.
// 200 + session                   — fresh session, signed with our kid.
// 200 (idempotent re-migration)   — bearer's `sub` already mapped here;
//                                    we issue a fresh session against
//                                    the existing user row.
func (h *authHandler) migrateIn(w http.ResponseWriter, r *http.Request) {
	bearer := extractBearer(r)
	if bearer == "" {
		writeErr(w, http.StatusUnauthorized, "missing_bearer", "Authorization required")
		return
	}
	claims, _, err := h.verifier.VerifyAnyKid(bearer)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "bad_bearer", err.Error())
		return
	}
	// Audience pinning: only access tokens may seed a migrate-in. The
	// 90-day refresh token has a much longer practical replay window;
	// requiring aud="chat" keeps the cross-region replay surface tight
	// to the 15-minute access TTL.
	if !slices.Contains(claims.Audience, jwt.AudienceChat) {
		writeErr(w, http.StatusUnauthorized, "wrong_audience", "access token required")
		return
	}

	var body migrateInReq
	// Body is optional — empty / malformed JSON falls back to "" device id.
	_ = json.NewDecoder(r.Body).Decode(&body)

	sess, err := h.svc.MigrateIn(r.Context(), claims, body.DeviceID)
	if errors.Is(err, service.ErrMigrateInAnonRejected) {
		writeErr(w, http.StatusBadRequest, "anonymous_rejected", "anonymous users do not migrate")
		return
	}
	if err != nil {
		slog.ErrorContext(r.Context(), "migrate_in_failed", "err", err.Error())
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	writeJSON(w, http.StatusOK, sessionToResp(sess))
}

// migrateRevoke handles POST /auth/migrate-revoke.
//
// 401 missing_bearer / bad_bearer — bearer absent or signature fails.
// 401 own_kid                    — bearer was signed by THIS region's
//                                   kid; revoking on receipt of our own
//                                   token has no semantic meaning (no
//                                   migration is in flight).
// 204                            — success. Idempotent: deleting an
//                                   already-gone user also returns 204.
func (h *authHandler) migrateRevoke(w http.ResponseWriter, r *http.Request) {
	bearer := extractBearer(r)
	if bearer == "" {
		writeErr(w, http.StatusUnauthorized, "missing_bearer", "Authorization required")
		return
	}
	claims, kid, err := h.verifier.VerifyAnyKid(bearer)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "bad_bearer", err.Error())
		return
	}
	if err := h.svc.MigrateRevoke(r.Context(), claims, kid); err != nil {
		if errors.Is(err, service.ErrMigrateInAnonRejected) {
			// Defence in depth: should be unreachable from this endpoint
			// but the sentinel is mapped to 400 to stay consistent with
			// migrate-in.
			writeErr(w, http.StatusBadRequest, "anonymous_rejected", err.Error())
			return
		}
		// The service refuses own-kid bearers with a plain errors.New
		// — string-match it so we surface a stable error code instead
		// of bleeding the message into 500.
		if err.Error() == "migrate-revoke: refused — bearer signed by us, no migration in flight" {
			writeErr(w, http.StatusUnauthorized, "own_kid", "bearer signed by this region")
			return
		}
		slog.ErrorContext(r.Context(), "migrate_revoke_failed", "err", err.Error())
		writeErr(w, http.StatusInternalServerError, "internal", "")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
