package profile

import (
	"time"

	"github.com/google/uuid"
)

// Me is a user as /auth/me shows them under the deployment's policy. An
// optional field is nil when the policy does not collect it or the user has
// no value. Tier and TierExpiresAt do not move with the policy; a nil
// TierExpiresAt means lifetime Pro or free. Each identity's Email is gated by
// the same rule as BuildClaims, while provider and subject always show.
type Me struct {
	UserID    uuid.UUID
	Anonymous bool
	CreatedAt time.Time

	Tier          string
	TierExpiresAt *time.Time

	Email      *string
	Name       *string
	PictureURL *string

	Identities []MeIdentity
}

// MeIdentity is one identity inside Me.
type MeIdentity struct {
	Provider      string
	Subject       string
	Email         *string
	EmailVerified bool
	CreatedAt     time.Time
}

// SourceUser is the unfiltered raw projection of a user row + their
// identities + latest verified email. The caller loads everything from
// the DB (without considering policy), packs it into SourceUser, and
// hands it to ProjectMe. ProjectMe is the single choke-point that
// applies the deployment's profile policy to a /auth/me response.
type SourceUser struct {
	UserID    uuid.UUID
	Anonymous bool
	CreatedAt time.Time

	Tier          string
	TierExpiresAt *time.Time

	// Latest verified email from auth.identities, or empty string if
	// the user has no verified-email identity.
	Email string
	// Display name from auth.users.name, or empty string.
	Name string
	// Profile picture URL from auth.users.picture_url, or empty string.
	PictureURL string

	Identities []SourceIdentity
}

// SourceIdentity is one row from auth.identities as seen pre-policy.
type SourceIdentity struct {
	Provider      string
	Subject       string
	Email         string // empty when NULL in DB
	EmailVerified bool
	CreatedAt     time.Time
}

// ProjectMe applies this profile's collection policy to the raw user
// record and returns Me. A disabled field stays nil regardless of what the
// database held.
func (p ProfilePolicy) ProjectMe(s SourceUser) Me {
	out := Me{
		UserID:        s.UserID,
		Anonymous:     s.Anonymous,
		CreatedAt:     s.CreatedAt,
		Tier:          s.Tier,
		TierExpiresAt: s.TierExpiresAt,
	}
	if p.Email.Enabled && s.Email != "" {
		em := s.Email
		out.Email = &em
	}
	if p.Name.Enabled && s.Name != "" {
		n := s.Name
		out.Name = &n
	}
	if p.AvatarURL.Enabled && s.PictureURL != "" {
		pic := s.PictureURL
		out.PictureURL = &pic
	}
	out.Identities = make([]MeIdentity, 0, len(s.Identities))
	for _, src := range s.Identities {
		mi := MeIdentity{
			Provider:      src.Provider,
			Subject:       src.Subject,
			EmailVerified: src.EmailVerified,
			CreatedAt:     src.CreatedAt,
		}
		if p.Email.Enabled && src.Email != "" {
			em := src.Email
			mi.Email = &em
			mi.EmailVerified = src.EmailVerified
		} else {
			// Email collection disabled → strip both fields, mirroring
			// BuildClaims behaviour so /auth/me and JWT claims agree.
			mi.EmailVerified = false
		}
		out.Identities = append(out.Identities, mi)
	}
	return out
}
