package session

import (
	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/auth/internal/domain/profile"
	"github.com/jiva-studio/shruti/authjwt"
)

// buildClaims composes what both tokens of a pair carry; the caller fills
// the audience, TTL and JTI. The policy decides only whether identities keep
// EmailHash and EmailVerified: tier, quota id, RevenueCat customer id and
// provider/subject pairs always ship, since chat attributes requests by them
// even when email is not collected.
func buildClaims(
	p profile.ProfilePolicy,
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
