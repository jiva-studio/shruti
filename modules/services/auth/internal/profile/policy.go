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
type ProfilePolicy struct {
	Email      FieldPolicy `yaml:"email"`
	Name       FieldPolicy `yaml:"name"`
	AvatarURL  FieldPolicy `yaml:"avatar_url"`
	Locale     FieldPolicy `yaml:"locale"`
	DeviceID   FieldPolicy `yaml:"device_id"`
	LastSeenAt FieldPolicy `yaml:"last_seen_at"`
	Phone      FieldPolicy `yaml:"phone"`
}
