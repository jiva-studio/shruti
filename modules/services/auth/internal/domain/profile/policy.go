// Package profile applies the per-deployment field-collection policy: which
// optional profile fields are stored (FromOAuth) and returned by /auth/me
// (ProjectMe); the session use case applies the same policy to token claims.
// The policy comes from config.yaml's `profile_collection.profiles.{name}`
// section, chosen at boot by the PROFILE env var.
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
// Only fields an OAuth provider (Google / Apple) returns and auth.users /
// auth.identities persist are tracked here; a new optional field joins
// together with its first consumer.
type ProfilePolicy struct {
	Email     FieldPolicy
	Name      FieldPolicy
	AvatarURL FieldPolicy
}
