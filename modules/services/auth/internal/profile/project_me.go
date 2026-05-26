package profile

import (
	"time"

	"github.com/google/uuid"
)

// MeUser is the projected /auth/me response. Optional pointer fields
// render as `null` either when the policy disables collection of that
// field or when the underlying DB row had no value. JSON keys stay
// camelCase to match the pre-policy wire contract — global profile
// with a fully-populated user produces output byte-identical to the
// previous MeResponse path. RU profile renders the same shape but
// with email/name/pictureUrl always null.
type MeUser struct {
	UserID    uuid.UUID `json:"userId"`
	Anonymous bool      `json:"anonymous"`
	CreatedAt time.Time `json:"createdAt"`

	// Subscription mirror from RevenueCat. Always emitted — quota /
	// tier do not move with profile policy. Tier always set (defaults
	// to "free" upstream). TierExpiresAt nil means lifetime Pro or free.
	Tier          string     `json:"tier"`
	TierExpiresAt *time.Time `json:"tierExpiresAt,omitempty"`

	// Policy-gated optional fields. No `omitempty` so the JSON keys
	// remain in the payload (rendered as `null` when nil) — this is
	// what mobile/legacy clients have always seen on global. RU
	// deployments will see them always-null; the mobile code path
	// `name ?? email ?? signedIn` falls back gracefully.
	Email      *string `json:"email"`
	Name       *string `json:"name"`
	PictureURL *string `json:"pictureUrl"`

	// Identities are gated by policy too: when Email.Enabled=false the
	// per-identity Email field is suppressed (same rule as
	// BuildClaims), but provider/subject ship so the destination
	// region can mirror the row on migrate-in.
	Identities []MeIdentity `json:"identities"`

	// HomeRegion is the server-authoritative region the user belongs
	// to (auth.users.home_region, NOT NULL DEFAULT 'global'). Always
	// emitted regardless of profile policy — mobile relies on this to
	// reconcile its local activeServer.id with server truth after each
	// /auth/me fetch. Not nullable on the wire.
	HomeRegion string `json:"homeRegion"`
}

// MeIdentity is a single identity row inside /auth/me. Provider and
// subject always ship; Email is gated by ProfilePolicy.Email.Enabled.
type MeIdentity struct {
	Provider      string    `json:"provider"`
	Subject       string    `json:"subject"`
	Email         *string   `json:"email"`
	EmailVerified bool      `json:"emailVerified"`
	CreatedAt     time.Time `json:"createdAt"`
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

	// HomeRegion is the raw auth.users.home_region value. Defaults to
	// "global" via the DB schema; passed through unchanged into MeUser.
	HomeRegion string

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
// record and returns the wire-shaped MeUser. Disabled fields are
// omitted (pointer stays nil) regardless of what the DB held.
//
// The global profile (every FieldPolicy.Enabled=true) plus a fully
// populated SourceUser reproduces the previous MeResponse shape
// byte-for-byte — that is the migration invariant for this PR.
func (p ProfilePolicy) ProjectMe(s SourceUser) MeUser {
	out := MeUser{
		UserID:        s.UserID,
		Anonymous:     s.Anonymous,
		CreatedAt:     s.CreatedAt,
		Tier:          s.Tier,
		TierExpiresAt: s.TierExpiresAt,
		// HomeRegion is not policy-gated — every deployment exposes it
		// so mobile can reconcile its local activeServer state against
		// the server-authoritative region.
		HomeRegion: s.HomeRegion,
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
