// Package profile loads and applies the per-deployment field-collection
// policy. Selecting which optional profile fields are stored, returned,
// and embedded in JWT claims is driven by config.yaml's
// `profile_collection.profiles.{name}` section, chosen at boot via the
// PROFILE env var.
//
// This file declares only the data shape. Use-cases (`FromOAuth`,
// `ProjectMe`, `BuildClaims`) ship in follow-up PRs (1.5b/c/d).
package profile

// FieldPolicy controls collection of a single optional profile field.
// Mandatory fields (provider/subject/tier/quota_id/...) are not represented
// here — they are always collected.
type FieldPolicy struct {
	Enabled bool   `yaml:"enabled"`
	Purpose string `yaml:"purpose"`
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
	Email     FieldPolicy `yaml:"email"`
	Name      FieldPolicy `yaml:"name"`
	AvatarURL FieldPolicy `yaml:"avatar_url"`
}
