// Package identityhash derives a stable, non-PII rate-limit key from
// a user's identities.
//
// JWT `sub` is the transient auth.users.id. DeleteAccount cascades the
// row away; the next signin with the same provider+subject mints a
// fresh uuid, so a counter keyed on `sub` would refresh the quota for
// free. For anonymous (device-only) users, keying on `sub` would let
// uninstall+reinstall reset the anon counter, turning the nominal
// 3/day anon cap into effectively unlimited.
//
// So the key survives delete+recreate by hashing the earliest
// non-device identity when one exists, or the earliest device
// identity when the user is anonymous:
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
// poisoning the counter from outside. The deployment supplies it
// (ANON_QUOTA_PEPPER); LegacyDevicePepper is the fallback so an unset
// deployment keeps its existing buckets.
package identityhash

import (
	"crypto/sha256"
	"encoding/hex"

	"github.com/jiva-studio/shruti/auth/internal/domain/account"
)

// LegacyDevicePepper is the fallback pepper, so a deployment that has
// not set ANON_QUOTA_PEPPER keeps its in-flight anon counters. It is in
// public source, so it peppers nothing — set the env var.
const LegacyDevicePepper = "shruti-anon-quota-v1"

// Compute returns the stable quota_id for a user given their identities.
// devicePepper salts the device-only hash so an attacker who scrapes device
// ids cannot precompute bucket keys; rotating it resets every anon counter.
//
// Non-empty for every non-empty input. Returns "" only when the slice
// is empty / nil (no identities at all, which only happens transiently
// inside the signin transaction before the first identity is inserted).
//
// Deterministic: the same set of identities always produces the same
// hash, regardless of slice order or insertion timing.
func Compute(identities []account.Identity, devicePepper string) string {
	var earliestNonDevice *account.Identity
	var earliestDevice *account.Identity
	for i := range identities {
		id := &identities[i]
		if id.Provider == account.ProviderDevice {
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
