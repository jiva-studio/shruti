// Package profile applies the per-deployment field-collection policy: which
// optional profile fields are stored (FromOAuth), returned by /auth/me
// (ProjectMe) and embedded in token claims (BuildClaims). The policy comes
// from config.yaml's `profile_collection.profiles.{name}` section, chosen at
// boot by the PROFILE env var.
package profile

// FieldPolicy controls collection of a single optional profile field.
// Mandatory fields (provider/subject/tier/quota_id/...) are not represented
// here — they are always collected.
type FieldPolicy struct {
	Enabled bool
	Purpose string
}

// ProfilePolicy is the collection-policy resolved for the current
// deployment. Selected by name from config.yaml at boot.
//
// Only fields that correspond to data actually returned by an OAuth
// provider (Google / Apple) and persisted on auth.users / auth.identities
// are tracked here. Speculative slots (phone, device_id, locale,
// last_seen_at) live in code only when a concrete consumer is added —
// reserving PII columns "for later" was a wrong-shape decision and got
// reverted in this PR.
type ProfilePolicy struct {
	Email     FieldPolicy
	Name      FieldPolicy
	AvatarURL FieldPolicy
}
