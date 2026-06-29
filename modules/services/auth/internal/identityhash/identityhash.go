// Package identityhash derives a stable, non-PII rate-limit key from
// a user's identities.
//
// Problem: chat rate-limit counters are keyed by JWT `sub`, which is
// the transient auth.users.id. DeleteAccount cascades the row away;
// the next signin with the same provider+subject mints a fresh uuid
// and a fresh `rl:chat:user:<new_uuid>:<today>` key. Quota refreshes
// for free (per issue #626). Before PR-1 anonymous (device-only) users
// got an empty quota_id and the chat side fell back to `sub` — which
// meant uninstall+reinstall reset the anon counter, turning the
// nominal 3/day anon cap into effectively unlimited.
//
// Fix: derive a key that survives delete+recreate by hashing the
// EARLIEST non-device identity when one exists, OR the earliest
// device identity when the user is anonymous:
//
//	non-device user:  quota_id = sha256("<provider>:<subject>")
//	device-only user: quota_id = sha256_16("device|<subject>|<pepper>")
//
// Same Google sub → same hash → same Redis bucket, regardless of
// whether the user_id is fresh. Same device install → same anon
// counter across uninstall/reinstall (device id is OS-stable on iOS
// IDFV, Android Settings.Secure.ANDROID_ID; survives a process kill
// and most reinstalls).
//
// Why earliest-by-created_at for the OAuth case: stability. If we
// keyed on the latest identity, adding a new provider would reset
// the counter (legitimate user "rewards"); deleting an account and
// re-signing in via a DIFFERENT provider would also create a new
// counter (abuse). Earliest pins both behaviours to the original
// identity, which is what users naturally think of as "their
// account". Same logic applies to the device-only path — earliest
// device identity wins.
//
// The pepper on the device-only path prevents an adversary who learns
// a device_id from computing the rate-limit bucket and predicting /
// poisoning the counter from outside. Today the pepper is a hardcoded
// per-deployment value; making it env-driven (and rotation-aware) is
// a follow-up if we ever observe abuse — TODO.
package identityhash

import (
	"crypto/sha256"
	"encoding/hex"

	"github.com/jiva-studio/lectorium/auth/internal/store"
)

// providerDevice mirrors service.ProviderDevice. Duplicated here to
// avoid an import cycle (service depends on this package for the JWT
// claim). These provider strings are baked into auth.identities rows
// and effectively immutable — renaming on one side without the other
// would corrupt existing data, so the duplication is safe.
const providerDevice = "device"

// devicePepper salts the device-only quota_id so an attacker who
// scrapes device IDs can't precompute Redis bucket keys.
// Per-deployment constant for now — rotation would invalidate every
// in-flight anon counter, which is acceptable but noisy, hence the
// hardcode until we see a reason to rotate. See package doc TODO.
const devicePepper = "shruti-anon-quota-v1"

// Compute returns the stable quota_id for a user given their identities.
//
// Non-empty for every non-empty input. Returns "" only when the slice
// is empty / nil (no identities at all, which only happens transiently
// inside the signin transaction before the first identity is inserted).
//
// Deterministic: the same set of identities always produces the same
// hash, regardless of slice order or insertion timing.
func Compute(identities []store.Identity) string {
	var earliestNonDevice *store.Identity
	var earliestDevice *store.Identity
	for i := range identities {
		id := &identities[i]
		if id.Provider == providerDevice {
			if earliestDevice == nil || id.CreatedAt.Before(earliestDevice.CreatedAt) {
				earliestDevice = id
			}
			continue
		}
		if earliestNonDevice == nil || id.CreatedAt.Before(earliestNonDevice.CreatedAt) {
			earliestNonDevice = id
		}
	}
	if earliestNonDevice != nil {
		sum := sha256.Sum256([]byte(earliestNonDevice.Provider + ":" + earliestNonDevice.Subject))
		return hex.EncodeToString(sum[:])
	}
	if earliestDevice != nil {
		// Full 64-char hex so the chat-side _QUOTA_ID_RE
		// (^[0-9a-f]{64}$) accepts the value uniformly across the
		// device-only and OAuth paths — no special-casing on the
		// consumer.
		sum := sha256.Sum256([]byte("device|" + earliestDevice.Subject + "|" + devicePepper))
		return hex.EncodeToString(sum[:])
	}
	return ""
}
