// Package identityhash derives a stable, non-PII rate-limit key from
// a user's OAuth identities.
//
// Problem: chat rate-limit counters are keyed by JWT `sub`, which is
// the transient auth.users.id. DeleteAccount cascades the row away;
// the next signin with the same provider+subject mints a fresh uuid
// and a fresh `rl:chat:user:<new_uuid>:<today>` key. Quota refreshes
// for free (per issue #626).
//
// Fix: derive a key that survives delete+recreate by hashing the
// EARLIEST non-device identity:
//
//	quota_id = sha256("<provider>:<subject>")
//
// Same Google sub → same hash → same Redis bucket, regardless of
// whether the user_id is fresh. Anonymous users (device-only) get an
// empty quota_id; the chat-side limiter falls back to JWT `sub` for
// them — they're already bounded by a tiny anon limit (3/day) so the
// delete+recreate gain isn't worth the OAuth-less complexity.
//
// Why earliest-by-created_at and not most-recent: stability. If we
// keyed on the latest identity, adding a new provider would reset
// the counter (legitimate user "rewards"); deleting an account and
// re-signing in via a DIFFERENT provider would also create a new
// counter (abuse). Earliest pins both behaviours to the original
// identity, which is what users naturally think of as "their
// account".
package identityhash

import (
	"crypto/sha256"
	"encoding/hex"

	"github.com/jiva-studio/shruti/auth/internal/store"
)

// providerDevice mirrors service.ProviderDevice. Duplicated here to
// avoid an import cycle (service depends on this package for the JWT
// claim). These provider strings are baked into auth.identities rows
// and effectively immutable — renaming on one side without the other
// would corrupt existing data, so the duplication is safe.
const providerDevice = "device"

// Compute returns the stable quota_id for a user given their identities.
// Returns "" for users who only have the device-provider identity
// (anonymous) — the caller falls back to JWT `sub` in that case.
//
// Deterministic: the same set of identities always produces the same
// hash, regardless of slice order or insertion timing.
func Compute(identities []store.Identity) string {
	var earliest *store.Identity
	for i := range identities {
		id := &identities[i]
		if id.Provider == providerDevice {
			continue
		}
		if earliest == nil || id.CreatedAt.Before(earliest.CreatedAt) {
			earliest = id
		}
	}
	if earliest == nil {
		return ""
	}
	sum := sha256.Sum256([]byte(earliest.Provider + ":" + earliest.Subject))
	return hex.EncodeToString(sum[:])
}
