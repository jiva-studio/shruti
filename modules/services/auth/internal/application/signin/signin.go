// Package signin resolves who is signing in — an anonymous device, or the
// holder of a verified provider identity — to a user, creating, linking or
// upgrading one as needed, and opens a session for them.
package signin

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/auth/internal/application/session"
	"github.com/jiva-studio/shruti/auth/internal/domain/account"
	"github.com/jiva-studio/shruti/auth/internal/domain/profile"
	"github.com/jiva-studio/shruti/auth/internal/ports"
)

// Service signs users in. GoogleVerifier and AppleVerifier check their providers' id
// tokens; Policy decides which optional profile fields are stored.
type Service struct {
	Store          ports.Store
	UnitOfWork     ports.UnitOfWork
	Sessions       *session.Service
	GoogleVerifier ports.IDTokenVerifier
	AppleVerifier  ports.IDTokenVerifier
	Policy         profile.ProfilePolicy
}

// Input is what a sign-in request carries besides the credential itself.
type Input struct {
	IDToken  string
	FullName string // Apple only, optional
	DeviceID string // optional; recorded on the new refresh token
	// BearerAccess is the caller's current access token, if any; an
	// anonymous one is upgraded by the sign-in.
	BearerAccess string
	// Nonce is the raw nonce the client bound into the id token; optional.
	// When set, the token's `nonce` claim must match it: equal for Google,
	// sha256 of it for Apple, hex or unpadded base64url. When empty the claim
	// is not checked.
	Nonce string
}

// Anonymous opens a device-anonymous session.
//
// A bearer naming a signed-in user who still exists gets that user's
// session back unchanged: no anonymous user is created and nobody is signed
// out. Otherwise the (device, deviceId) identity is looked up, and on a miss
// a new user with that identity is created.
func (s *Service) Anonymous(ctx context.Context, deviceID string, bearerAccess string) (*session.Session, error) {
	if deviceID == "" {
		return nil, fmt.Errorf("deviceId is required")
	}

	if uid, anonymous, ok := s.Sessions.BearerUser(bearerAccess); ok && !anonymous {
		// An unexpired access token can outlive its account; re-issuing for
		// a deleted user would violate the refresh token's foreign key, so
		// a missing user falls through to the anonymous path.
		u, err := s.Store.Users().Get(ctx, uid)
		if err != nil {
			return nil, err
		}
		if u != nil {
			return s.Sessions.Issue(ctx, uid, false, deviceID)
		}
	}

	ident, err := s.Store.Identities().Get(ctx, account.ProviderDevice, deviceID)
	if err != nil {
		return nil, err
	}
	if ident != nil {
		return s.Sessions.Issue(ctx, ident.UserID, true, deviceID)
	}

	var userID uuid.UUID
	err = s.UnitOfWork.Do(ctx, func(tx ports.Store) error {
		uid, err := tx.Users().Create(ctx)
		if err != nil {
			return err
		}
		userID = uid
		return tx.Identities().Create(ctx, account.Identity{
			Provider: account.ProviderDevice,
			Subject:  deviceID,
			UserID:   uid,
		})
	})
	if err != nil {
		return nil, fmt.Errorf("anonymous: %w", err)
	}
	return s.Sessions.Issue(ctx, userID, true, deviceID)
}

// Google signs in with a Google id token.
func (s *Service) Google(ctx context.Context, in Input) (*session.Session, error) {
	ident, err := s.GoogleVerifier.Verify(ctx, in.IDToken)
	if err != nil {
		return nil, fmt.Errorf("google verify: %w", err)
	}
	if in.Nonce != "" && !nonceEqual(ident.Nonce, in.Nonce) {
		return nil, errors.New("google verify: nonce mismatch")
	}
	return s.WithIdentity(ctx, account.ProviderGoogle, ident, in)
}

// Apple signs in with an Apple id token.
func (s *Service) Apple(ctx context.Context, in Input) (*session.Session, error) {
	ident, err := s.AppleVerifier.Verify(ctx, in.IDToken)
	if err != nil {
		return nil, fmt.Errorf("apple verify: %w", err)
	}
	if in.Nonce != "" {
		// Apple's samples hex-encode the hash, OIDC clients base64url it.
		sum := sha256.Sum256([]byte(in.Nonce))
		if !nonceEqual(ident.Nonce, hex.EncodeToString(sum[:])) &&
			!nonceEqual(ident.Nonce, base64.RawURLEncoding.EncodeToString(sum[:])) {
			return nil, errors.New("apple verify: nonce mismatch")
		}
	}
	return s.WithIdentity(ctx, account.ProviderApple, ident, in)
}

// nonceEqual compares a token's nonce claim with the expected value in
// constant time; an absent claim never matches.
func nonceEqual(claim, want string) bool {
	return claim != "" && subtle.ConstantTimeCompare([]byte(claim), []byte(want)) == 1
}

// WithIdentity signs in the holder of an already verified provider identity:
// it resolves, creates or links the user and opens their session.
//
// The provider payload is filtered through the profile policy before any
// write, so fields the deployment does not collect never reach storage.
// When email is not collected, the cross-link by verified email is skipped:
// Google and Apple on the same person become two accounts, by design.
func (s *Service) WithIdentity(ctx context.Context, provider string, ident *account.ProviderIdentity, in Input) (*session.Session, error) {
	if ident.Subject == "" {
		return nil, fmt.Errorf("%s: empty subject", provider)
	}

	// Apple's fullName comes once, in the sign-in request body; fold it into
	// the provider payload so the policy sees one shape.
	rawName := ident.Name
	if rawName == "" {
		rawName = in.FullName
	}
	filtered := s.Policy.FromOAuth(profile.OAuthIdentityData{
		Provider:      provider,
		Subject:       ident.Subject,
		Email:         ident.Email,
		EmailVerified: ident.EmailVerified,
		Name:          rawName,
		AvatarURL:     ident.PictureURL,
	})

	// A concurrent sign-in of the same new identity can commit between the
	// lookup and the insert; the loser's transaction rolls back and one more
	// pass resolves the now-existing identity.
	userID, err := s.resolveUser(ctx, filtered, in)
	if errors.Is(err, account.ErrIdentityExists) {
		userID, err = s.resolveUser(ctx, filtered, in)
	}
	if err != nil {
		return nil, fmt.Errorf("signin %s: %w", provider, err)
	}
	// The mobile app logs in to RevenueCat with the token's sub, so the
	// customer id is the user id. Binding it here lets webhooks find the
	// user; it only writes while the column is NULL.
	if err := s.Store.Users().BindRCAppUserID(ctx, userID, userID.String()); err != nil {
		return nil, fmt.Errorf("signin %s: bind rc: %w", provider, err)
	}
	return s.Sessions.Issue(ctx, userID, false, in.DeviceID)
}

// resolveUser runs the resolve-or-create-or-link decision in one unit of
// work and returns the user the identity belongs to.
func (s *Service) resolveUser(ctx context.Context, filtered profile.FilteredIdentity, in Input) (uuid.UUID, error) {
	provider, subject := filtered.Provider, filtered.Subject
	var userID uuid.UUID
	err := s.UnitOfWork.Do(ctx, func(tx ports.Store) error {
		// 1. Existing identity: same user; refresh its email if it changed.
		existing, err := s.Store.Identities().Get(ctx, provider, subject)
		if err != nil {
			return err
		}
		if existing != nil {
			userID = existing.UserID
			if err := s.maybeUpdateIdentityEmail(ctx, tx, existing, filtered); err != nil {
				return err
			}
			return applyProfile(ctx, tx, userID, filtered)
		}

		// 2. Cross-link by verified email. A returning person who already
		//    has an account (Google in the app) lands on that account when
		//    they sign in with another provider sharing the verified email
		//    (Apple on the web), so tier and chat quota stay unified. This
		//    deliberately beats the anonymous upgrade below: every web
		//    visitor gets a throwaway per-device anonymous user, and letting
		//    it capture the identity would split one person into two
		//    accounts on one email.
		if s.Policy.Email.Enabled && filtered.EmailVerified && filtered.Email != "" {
			matchUID, err := s.Store.Identities().FindUserByVerifiedEmail(ctx, filtered.Email)
			if err != nil {
				return err
			}
			if matchUID != uuid.Nil {
				userID = matchUID
				return createIdentity(ctx, tx, matchUID, filtered)
			}
		}

		// 3. An anonymous bearer is upgraded, keeping that user's data.
		//    Reached only when no account owns this verified email.
		if uid, anonymous, ok := s.Sessions.BearerUser(in.BearerAccess); ok && anonymous {
			userID = uid
			return createIdentity(ctx, tx, uid, filtered)
		}

		// 4. A new user.
		uid, err := tx.Users().Create(ctx)
		if err != nil {
			return err
		}
		userID = uid
		return createIdentity(ctx, tx, uid, filtered)
	})
	return userID, err
}

// createIdentity records the identity for userID. With email suppressed by
// the policy the row gets email NULL and email_verified false — the shape of
// a provider that returned none.
func createIdentity(ctx context.Context, tx ports.Store, userID uuid.UUID, f profile.FilteredIdentity) error {
	row := account.Identity{
		Provider:      f.Provider,
		Subject:       f.Subject,
		UserID:        userID,
		EmailVerified: f.EmailVerified,
	}
	if f.Email != "" {
		em := f.Email
		row.Email = &em
	}
	if err := tx.Identities().Create(ctx, row); err != nil {
		return err
	}
	return applyProfile(ctx, tx, userID, f)
}

// applyProfile stores display name and avatar from the filtered payload.
// The name is set only while empty (Apple sends it once, and a later Google
// sign-in must not clobber it); the picture is always overwritten, since
// Google rotates avatar URLs. An empty value writes nothing.
func applyProfile(ctx context.Context, tx ports.Store, userID uuid.UUID, f profile.FilteredIdentity) error {
	if f.Name != "" {
		if err := tx.Users().SetNameIfEmpty(ctx, userID, f.Name); err != nil {
			return err
		}
	}
	if f.AvatarURL != "" {
		if err := tx.Users().SetPictureURL(ctx, userID, f.AvatarURL); err != nil {
			return err
		}
	}
	return nil
}

// maybeUpdateIdentityEmail refreshes an existing identity's email only when
// the policy collects email and the value changed (Apple usually re-issues
// the same relay address). With email suppressed it writes nothing — not even
// NULL over an old address, since the row was created under the same policy.
func (s *Service) maybeUpdateIdentityEmail(ctx context.Context, tx ports.Store, existing *account.Identity, f profile.FilteredIdentity) error {
	if !s.Policy.Email.Enabled {
		return nil
	}
	freshEmail := emptyToNil(f.Email)
	if equalPtrStr(existing.Email, freshEmail) && existing.EmailVerified == f.EmailVerified {
		return nil
	}
	return tx.Identities().UpdateEmail(ctx, existing.Provider, existing.Subject, freshEmail, f.EmailVerified)
}

func emptyToNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func equalPtrStr(a, b *string) bool {
	switch {
	case a == nil && b == nil:
		return true
	case a == nil || b == nil:
		return false
	default:
		return *a == *b
	}
}
