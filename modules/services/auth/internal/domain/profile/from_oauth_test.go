package profile

import "testing"

func TestFromOAuth_AllEnabled(t *testing.T) {
	p := ProfilePolicy{
		Email:     FieldPolicy{Enabled: true},
		Name:      FieldPolicy{Enabled: true},
		AvatarURL: FieldPolicy{Enabled: true},
	}
	in := OAuthIdentityData{
		Provider:      "google",
		Subject:       "g123",
		Email:         "alice@example.com",
		EmailVerified: true,
		Name:          "Alice",
		AvatarURL:     "https://example.test/avatar.png",
	}
	out := p.FromOAuth(in)
	if out.Provider != "google" || out.Subject != "g123" {
		t.Errorf("mandatory fields lost: %+v", out)
	}
	if out.Email != "alice@example.com" {
		t.Errorf("email should pass through, got %q", out.Email)
	}
	if !out.EmailVerified {
		t.Errorf("email_verified should pass through")
	}
	if out.Name != "Alice" {
		t.Errorf("name should pass through, got %q", out.Name)
	}
	if out.AvatarURL == "" {
		t.Errorf("avatar should pass through")
	}
}

func TestFromOAuth_RuProfileDropsPii(t *testing.T) {
	// RU profile: email, name, avatar all disabled. Provider+subject
	// always survive — the service still needs them to bind the
	// identity row even when no PII is collected.
	p := ProfilePolicy{
		Email:     FieldPolicy{Enabled: false},
		Name:      FieldPolicy{Enabled: false},
		AvatarURL: FieldPolicy{Enabled: false},
	}
	in := OAuthIdentityData{
		Provider:      "google",
		Subject:       "g456",
		Email:         "bob@example.com",
		EmailVerified: true,
		Name:          "Bob",
		AvatarURL:     "https://example.test/avatar.png",
	}
	out := p.FromOAuth(in)
	if out.Email != "" {
		t.Errorf("email should be dropped, got %q", out.Email)
	}
	if out.EmailVerified {
		t.Errorf("email_verified should be false when email dropped")
	}
	if out.Name != "" {
		t.Errorf("name should be dropped, got %q", out.Name)
	}
	if out.AvatarURL != "" {
		t.Errorf("avatar should be dropped, got %q", out.AvatarURL)
	}
	// Mandatory fields always survive.
	if out.Provider != "google" || out.Subject != "g456" {
		t.Errorf("mandatory provider/subject must survive, got %+v", out)
	}
}

func TestFromOAuth_MixedPolicy(t *testing.T) {
	// Hypothetical mixed deployment: collect display name but no
	// contact email and no avatar. Verifies fields are independent.
	p := ProfilePolicy{
		Email:     FieldPolicy{Enabled: false},
		Name:      FieldPolicy{Enabled: true},
		AvatarURL: FieldPolicy{Enabled: false},
	}
	in := OAuthIdentityData{
		Provider:      "apple",
		Subject:       "a789",
		Email:         "carol@example.com",
		EmailVerified: true,
		Name:          "Carol",
		AvatarURL:     "https://example.test/c.png",
	}
	out := p.FromOAuth(in)
	if out.Email != "" {
		t.Error("email should be dropped")
	}
	if out.EmailVerified {
		t.Error("email_verified should be false when email dropped")
	}
	if out.Name != "Carol" {
		t.Errorf("name should pass through, got %q", out.Name)
	}
	if out.AvatarURL != "" {
		t.Errorf("avatar should be dropped, got %q", out.AvatarURL)
	}
}

func TestFromOAuth_EmailVerifiedForcedFalseWhenEmailDropped(t *testing.T) {
	// Defensive: even if the provider returned email_verified=true,
	// dropping the email must drop the verified flag too. Otherwise
	// FindUserByVerifiedEmail-style cross-link logic could fire on a
	// suppressed identity.
	p := ProfilePolicy{
		Email: FieldPolicy{Enabled: false},
	}
	in := OAuthIdentityData{
		Provider:      "google",
		Subject:       "sub-x",
		Email:         "x@example.com",
		EmailVerified: true,
	}
	out := p.FromOAuth(in)
	if out.Email != "" {
		t.Errorf("email should be empty: %q", out.Email)
	}
	if out.EmailVerified {
		t.Error("email_verified must be false when email is dropped")
	}
}

func TestFromOAuth_PreservesEmptyOptionalFields(t *testing.T) {
	// Provider didn't return name (Apple after first signin) — policy
	// is allowed but field stays empty. Output should reflect input.
	p := ProfilePolicy{
		Email:     FieldPolicy{Enabled: true},
		Name:      FieldPolicy{Enabled: true},
		AvatarURL: FieldPolicy{Enabled: true},
	}
	in := OAuthIdentityData{
		Provider:      "apple",
		Subject:       "a-empty",
		Email:         "e@example.com",
		EmailVerified: true,
	}
	out := p.FromOAuth(in)
	if out.Name != "" || out.AvatarURL != "" {
		t.Errorf("empty input fields must stay empty, got %+v", out)
	}
	if out.Email == "" {
		t.Error("email should not be dropped when present + enabled")
	}
}
