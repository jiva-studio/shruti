package profile

import (
	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/authjwt"
)

// BuildClaims composes a authjwt.IssueInput from a user's current state
// after applying the policy. Today the policy only governs whether
// email-bearing identities expose EmailHash + EmailVerified — the rest
// of the input is always populated:
//
//   - Tier, QuotaID, RCAppUserID, Identities (provider/subject pairs)
//     ship regardless of policy. The chat service relies on the
//     provider/subject pairs to attribute requests even when email
//     collection is suppressed.
//
//   - EmailHash + EmailVerified are stripped per identity when
//     Email.Enabled=false.
//
// The caller fills the per-token Audience, TTL and JTI fields — same
// IssueInput shape is used for access (audience=chat) and refresh
// (audience=auth), only those three fields differ between the pair.
func (p ProfilePolicy) BuildClaims(
	userID uuid.UUID,
	anonymous bool,
	tier string,
	tierExpiresAt int64,
	quotaID string,
	rcAppUserID string,
	identities []authjwt.ClaimIdentity,
) authjwt.IssueInput {
	filtered := make([]authjwt.ClaimIdentity, len(identities))
	for i, id := range identities {
		out := authjwt.ClaimIdentity{Provider: id.Provider, Subject: id.Subject}
		if p.Email.Enabled {
			out.EmailHash = id.EmailHash
			out.EmailVerified = id.EmailVerified
		}
		filtered[i] = out
	}
	return authjwt.IssueInput{
		UserID:        userID,
		Anonymous:     anonymous,
		Tier:          tier,
		QuotaID:       quotaID,
		TierExpiresAt: tierExpiresAt,
		RCAppUserID:   rcAppUserID,
		Identities:    filtered,
	}
}
