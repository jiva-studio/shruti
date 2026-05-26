package profile

// OAuthIdentityData is the raw extract from an OAuth provider before
// the ProfilePolicy decides what to retain. Pass everything the provider
// returned; this struct is filtered at the service boundary.
type OAuthIdentityData struct {
	Provider      string
	Subject       string
	Email         string
	EmailVerified bool
	Name          string
	AvatarURL     string
}

// FilteredIdentity is the subset of OAuthIdentityData that this policy
// permits the service to persist. Provider + Subject always survive;
// Email / Name / AvatarURL are zeroed when the policy disables them.
// EmailVerified is forced false whenever Email is dropped — otherwise
// downstream code (cross-link by verified email) could fire on a
// suppressed address.
type FilteredIdentity struct {
	Provider      string
	Subject       string
	Email         string
	EmailVerified bool
	Name          string
	AvatarURL     string
}

// FromOAuth applies this profile's collection policy to a raw OAuth
// payload. Fields with `enabled: false` are zeroed at this boundary so
// downstream code (createIdentity, applyProfile, maybeUpdateIdentityEmail)
// observes the same shape as a provider that simply didn't return them.
func (p ProfilePolicy) FromOAuth(d OAuthIdentityData) FilteredIdentity {
	out := FilteredIdentity{
		Provider: d.Provider,
		Subject:  d.Subject,
	}
	if p.Email.Enabled {
		out.Email = d.Email
		out.EmailVerified = d.EmailVerified
	}
	if p.Name.Enabled {
		out.Name = d.Name
	}
	if p.AvatarURL.Enabled {
		out.AvatarURL = d.AvatarURL
	}
	return out
}
