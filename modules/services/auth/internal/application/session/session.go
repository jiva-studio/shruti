// Package session issues, rotates and revokes a signed-in device's tokens.
//
//   - access  — 15 min, signed (RS256, kid=v1), aud=chat; carries the
//     user's anonymous flag, tier, quota id and identities.
//   - refresh — 90 days, aud=auth, single use: a refresh rotates it under
//     a row lock and records the successor on the revoked row.
package session

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/auth/internal/domain/account"
	"github.com/jiva-studio/shruti/auth/internal/domain/identityhash"
	"github.com/jiva-studio/shruti/auth/internal/domain/profile"
	"github.com/jiva-studio/shruti/auth/internal/ports"
	"github.com/jiva-studio/shruti/authjwt"
)

const (
	AccessTTL  = 15 * time.Minute
	RefreshTTL = 90 * 24 * time.Hour
)

// Session is what every sign-in and refresh returns to clients.
type Session struct {
	AccessToken  string
	RefreshToken string
	UserID       uuid.UUID
	Anonymous    bool
}

// ErrRefreshRejected marks a refresh failure caused by the token itself —
// malformed/expired signature, unknown jti, revoked, or past expiry. The
// handler maps it to 401 so the client drops the session. Every other
// Refresh error (database unreachable mid-deploy, signer failure) is
// infrastructural and maps to 5xx, so a brief backend blip does not sign the
// user out.
var ErrRefreshRejected = errors.New("refresh token rejected")

// Service owns the token lifecycle. Policy decides which optional profile
// fields enter the claims; QuotaPepper salts the quota id of device-only
// users.
type Service struct {
	Store       ports.Store
	UnitOfWork  ports.UnitOfWork
	Signer      ports.TokenSigner
	Verifier    ports.TokenVerifier
	Policy      profile.ProfilePolicy
	QuotaPepper string
	Now         func() time.Time
}

// Issue mints a fresh access and refresh token for the user and records the
// refresh token, bound to deviceID when one is given.
func (s *Service) Issue(ctx context.Context, userID uuid.UUID, anonymous bool, deviceID string) (*Session, error) {
	base, err := s.claims(ctx, userID, anonymous)
	if err != nil {
		return nil, err
	}
	access, refresh, newJTI, err := s.sign(base)
	if err != nil {
		return nil, err
	}
	var dev *string
	if deviceID != "" {
		d := deviceID
		dev = &d
	}
	if err := s.Store.RefreshTokens().Create(ctx, account.RefreshToken{
		JTI:       newJTI,
		UserID:    userID,
		DeviceID:  dev,
		ExpiresAt: s.Now().Add(RefreshTTL),
	}); err != nil {
		return nil, err
	}
	return &Session{AccessToken: access, RefreshToken: refresh, UserID: userID, Anonymous: anonymous}, nil
}

// Refresh rotates a single-use refresh token.
//
// Invariants:
//   - the row lock serialises concurrent /refresh calls on one token;
//   - the old jti is revoked in the same transaction;
//   - the new access token carries the user's current anonymous flag,
//     re-derived from their identities.
func (s *Service) Refresh(ctx context.Context, refreshToken string) (*Session, error) {
	claims, err := s.Verifier.VerifyRefresh(refreshToken)
	if err != nil {
		return nil, fmt.Errorf("refresh: %w: %v", ErrRefreshRejected, err)
	}
	jti, err := claims.JTI()
	if err != nil {
		return nil, fmt.Errorf("refresh: %w: %v", ErrRefreshRejected, err)
	}

	var session *Session
	err = s.UnitOfWork.Do(ctx, func(tx ports.Store) error {
		row, err := tx.RefreshTokens().LockForRotation(ctx, jti)
		if err != nil {
			return err
		}
		if row == nil {
			return fmt.Errorf("%w: unknown refresh token", ErrRefreshRejected)
		}

		// The token to rotate FROM: normally the presented one; for a
		// revoked one it may be its live successor (lost-response replay).
		src := row
		if row.RevokedAt != nil {
			src, err = s.resolveReplay(ctx, tx, row)
			if err != nil {
				return err
			}
		} else if s.Now().After(row.ExpiresAt) {
			return fmt.Errorf("%w: refresh token expired", ErrRefreshRejected)
		}

		sess, err := s.rotateFrom(ctx, tx, src)
		if err != nil {
			return err
		}
		session = sess
		return nil
	})
	return session, err
}

// resolveReplay decides whether a revoked presented token can recover a
// session. A rotation revokes the old token and records its successor; a
// lost rotation response leaves the client retrying the old token. If that
// successor is still alive and unused, the original response simply never
// arrived — rotate from the successor. If the successor was already spent
// (or the revocation was a signout, with no successor), this is reuse and
// stays a rejection.
//
// An attacker holding a stolen refresh token who races the legitimate client
// before it spends the successor could take over the chain here; possessing
// a refresh token is already an account compromise, and reuse of a
// superseded token is still refused.
func (s *Service) resolveReplay(ctx context.Context, tx ports.Store, row *account.RefreshToken) (*account.RefreshToken, error) {
	if row.ReplacedBy == nil {
		return nil, fmt.Errorf("%w: refresh token revoked", ErrRefreshRejected)
	}
	succ, err := tx.RefreshTokens().LockForRotation(ctx, *row.ReplacedBy)
	if err != nil {
		return nil, err
	}
	if succ == nil {
		return nil, fmt.Errorf("%w: refresh token revoked", ErrRefreshRejected)
	}
	if succ.RevokedAt != nil {
		return nil, fmt.Errorf("%w: refresh token reused", ErrRefreshRejected)
	}
	if s.Now().After(succ.ExpiresAt) {
		return nil, fmt.Errorf("%w: refresh token expired", ErrRefreshRejected)
	}
	return succ, nil
}

// rotateFrom revokes src, links it to a freshly issued successor, and
// returns the new session. The successor is created first so a later replay
// of src can follow replaced_by.
func (s *Service) rotateFrom(ctx context.Context, tx ports.Store, src *account.RefreshToken) (*Session, error) {
	idents, err := s.Store.Identities().ListForUser(ctx, src.UserID)
	if err != nil {
		return nil, err
	}
	anonymous := account.IsAnonymous(idents)
	base, err := s.claims(ctx, src.UserID, anonymous)
	if err != nil {
		return nil, err
	}
	access, refresh, newJTI, err := s.sign(base)
	if err != nil {
		return nil, err
	}
	if err := tx.RefreshTokens().Create(ctx, account.RefreshToken{
		JTI:       newJTI,
		UserID:    src.UserID,
		DeviceID:  src.DeviceID,
		ExpiresAt: s.Now().Add(RefreshTTL),
	}); err != nil {
		return nil, err
	}
	if err := tx.RefreshTokens().MarkRevokedWithSuccessor(ctx, src.JTI, newJTI); err != nil {
		return nil, err
	}
	return &Session{AccessToken: access, RefreshToken: refresh, UserID: src.UserID, Anonymous: anonymous}, nil
}

// Signout revokes the given refresh token (this device only). A token that
// does not verify carries no id to revoke — the client is signed out either
// way — so it is a no-op.
func (s *Service) Signout(ctx context.Context, refreshToken string) error {
	jti, ok := s.refreshJTI(refreshToken)
	if !ok {
		return nil
	}
	return s.UnitOfWork.Do(ctx, func(tx ports.Store) error {
		row, err := tx.RefreshTokens().LockForRotation(ctx, jti)
		if err != nil {
			return err
		}
		if row == nil {
			return nil
		}
		return tx.RefreshTokens().MarkRevoked(ctx, jti)
	})
}

// refreshJTI reads a refresh token's id; ok is false for a token that does
// not verify.
func (s *Service) refreshJTI(refreshToken string) (uuid.UUID, bool) {
	claims, err := s.Verifier.VerifyRefresh(refreshToken)
	if err != nil {
		return uuid.Nil, false
	}
	jti, err := claims.JTI()
	if err != nil {
		return uuid.Nil, false
	}
	return jti, true
}

// BearerUser reads a bearer access token (aud=chat, unexpired) and reports
// its user and anonymous flag; any other token yields ok=false.
func (s *Service) BearerUser(bearer string) (userID uuid.UUID, anonymous, ok bool) {
	if bearer == "" {
		return uuid.Nil, false, false
	}
	claims, err := s.Verifier.VerifyAccess(bearer)
	if err != nil {
		return uuid.Nil, false, false
	}
	uid, err := claims.UserID()
	if err != nil {
		return uuid.Nil, false, false
	}
	return uid, claims.Anonymous, true
}

// sign issues the access and refresh tokens over the same claims.
func (s *Service) sign(base authjwt.IssueInput) (access, refresh string, refreshJTI uuid.UUID, err error) {
	accessIn := base
	accessIn.Audience = authjwt.AudienceChat
	accessIn.TTL = AccessTTL
	access, _, err = s.Signer.Issue(accessIn)
	if err != nil {
		return "", "", uuid.Nil, err
	}
	refreshJTI = uuid.New()
	refreshIn := base
	refreshIn.Audience = authjwt.AudienceAuth
	refreshIn.TTL = RefreshTTL
	refreshIn.JTI = refreshJTI
	refresh, _, err = s.Signer.Issue(refreshIn)
	if err != nil {
		return "", "", uuid.Nil, err
	}
	return access, refresh, refreshJTI, nil
}

// claims gathers what a token says about the user: the effective tier and
// its expiry, the quota id, the identities (email hashed) and the RevenueCat
// customer id, filtered through the profile policy.
func (s *Service) claims(ctx context.Context, userID uuid.UUID, anonymous bool) (authjwt.IssueInput, error) {
	u, err := s.Store.Users().Get(ctx, userID)
	if err != nil {
		return authjwt.IssueInput{}, fmt.Errorf("load tier: %w", err)
	}
	tier, tierExp := tierClaim(u, s.Now().UTC())
	idents, err := s.Store.Identities().ListForUser(ctx, userID)
	if err != nil {
		return authjwt.IssueInput{}, fmt.Errorf("load identities: %w", err)
	}
	quotaID := identityhash.Compute(idents, s.QuotaPepper)
	rcAppUserID := ""
	if u != nil && u.RCAppUserID != nil {
		rcAppUserID = *u.RCAppUserID
	}
	return s.Policy.BuildClaims(userID, anonymous, tier, tierExp, quotaID, rcAppUserID, claimIdentities(idents)), nil
}

// tierClaim is the tier a token carries and its expiry in UNIX seconds. A
// lapsed "pro" reads as free; the stored row is corrected by the next
// webhook or reconcile pass, not here.
func tierClaim(u *account.User, now time.Time) (tier string, expiresAtEpoch int64) {
	if u == nil || u.Tier == "" {
		return account.TierFree, 0
	}
	if u.TierExpiresAt != nil {
		expiresAtEpoch = u.TierExpiresAt.Unix()
	}
	return account.EffectiveTier(u.Tier, u.TierExpiresAt, now), expiresAtEpoch
}

// claimIdentities shapes identities for the `ids` claim. The email is hashed
// (sha256 of lower+trimmed) so the raw address never enters a token; whether
// the hash is emitted is the policy's decision.
func claimIdentities(rows []account.Identity) []authjwt.ClaimIdentity {
	out := make([]authjwt.ClaimIdentity, 0, len(rows))
	for _, r := range rows {
		ci := authjwt.ClaimIdentity{
			Provider:      r.Provider,
			Subject:       r.Subject,
			EmailVerified: r.EmailVerified,
		}
		if r.Email != nil && *r.Email != "" {
			norm := strings.ToLower(strings.TrimSpace(*r.Email))
			sum := sha256.Sum256([]byte(norm))
			ci.EmailHash = hex.EncodeToString(sum[:])
		}
		out = append(out, ci)
	}
	return out
}
