// Package service implements the business logic of the auth API.
//
// Tokens layout:
//   - access  — 15 min, signed (RS256, kid=v1), payload includes `anonymous`
//   - refresh — 90 days, signed too, single-use; refresh rotates jti and
//     marks the previous row revoked under SELECT … FOR UPDATE.
package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/akdasa-studios/lectorium/auth/internal/jwt"
	"github.com/akdasa-studios/lectorium/auth/internal/providers"
	"github.com/akdasa-studios/lectorium/auth/internal/store"
)

const (
	AccessTTL  = 15 * time.Minute
	RefreshTTL = 90 * 24 * time.Hour

	ProviderGoogle = "google"
	ProviderApple  = "apple"
	ProviderDevice = "device"
)

// Session is what every signin / refresh returns to clients.
type Session struct {
	AccessToken  string
	RefreshToken string
	UserID       uuid.UUID
	Anonymous    bool
}

// Service holds the deps. Methods are safe for concurrent use.
type Service struct {
	Pool             *pgxpool.Pool
	Users            *store.UserRepo
	Identities       *store.IdentityRepo
	RefreshTokens    *store.RefreshTokenRepo
	Signer           *jwt.Signer
	Verifier         *jwt.Verifier
	GoogleVerifier   ProviderVerifier
	AppleVerifier    ProviderVerifier
}

// ProviderVerifier is the interface satisfied by providers/{google,apple}.Verifier.
type ProviderVerifier interface {
	Verify(ctx context.Context, idToken string) (*providers.Identity, error)
}

// ─── Anonymous ──────────────────────────────────────────────────────────────

// Anonymous bootstraps a device-anonymous session.
//
// Idempotency: if `bearerAccess` decodes to a valid non-anonymous user, return
// that session unchanged (no anon user gets created, no signed-in user gets
// kicked out).
// Otherwise lookup `(device, deviceId)`; on miss create a new user + identity.
func (s *Service) Anonymous(ctx context.Context, deviceID string, bearerAccess string) (*Session, error) {
	if deviceID == "" {
		return nil, fmt.Errorf("deviceId is required")
	}

	if uid, ok := s.userFromBearer(bearerAccess); ok && !isAnonymousClaim(bearerAccess, s.Verifier) {
		// Already signed in with a social identity; refuse to overwrite.
		return s.issueSession(ctx, uid, false, deviceID)
	}

	ident, err := s.Identities.Get(ctx, ProviderDevice, deviceID)
	if err != nil {
		return nil, err
	}
	if ident != nil {
		return s.issueSession(ctx, ident.UserID, true, deviceID)
	}

	// Fresh anon — create user + (device, deviceId) identity in one tx.
	var userID uuid.UUID
	err = pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		uid, err := s.Users.Create(ctx, tx)
		if err != nil {
			return err
		}
		userID = uid
		return s.Identities.Create(ctx, tx, store.Identity{
			Provider: ProviderDevice,
			Subject:  deviceID,
			UserID:   uid,
		})
	})
	if err != nil {
		return nil, fmt.Errorf("anonymous: %w", err)
	}
	return s.issueSession(ctx, userID, true, deviceID)
}

// ─── Sign in (Google / Apple) ──────────────────────────────────────────────

type SocialInput struct {
	IDToken      string
	FullName     string // Apple-only, optional
	DeviceID     string // optional; if provided, recorded on the new refresh token
	BearerAccess string // optional; if anonymous, triggers upgrade-on-signin
}

// SigninGoogle and SigninApple share the same upstream logic; only the
// id-token verifier differs.
func (s *Service) SigninGoogle(ctx context.Context, in SocialInput) (*Session, error) {
	ident, err := s.GoogleVerifier.Verify(ctx, in.IDToken)
	if err != nil {
		return nil, fmt.Errorf("google verify: %w", err)
	}
	return s.signinSocial(ctx, ProviderGoogle, ident, in)
}

func (s *Service) SigninApple(ctx context.Context, in SocialInput) (*Session, error) {
	ident, err := s.AppleVerifier.Verify(ctx, in.IDToken)
	if err != nil {
		return nil, fmt.Errorf("apple verify: %w", err)
	}
	return s.signinSocial(ctx, ProviderApple, ident, in)
}

// signinSocial implements the central resolve-or-create-or-link decision tree.
// Documented in plan §"Sign-in поток".
func (s *Service) signinSocial(ctx context.Context, provider string, ident *providers.Identity, in SocialInput) (*Session, error) {
	if ident.Subject == "" {
		return nil, fmt.Errorf("%s: empty subject", provider)
	}

	var userID uuid.UUID
	err := pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		// 1. Existing identity?  Same user, just refresh email if changed.
		existing, err := s.Identities.Get(ctx, provider, ident.Subject)
		if err != nil {
			return err
		}
		if existing != nil {
			userID = existing.UserID
			if err := s.maybeUpdateIdentityEmail(ctx, tx, existing, ident); err != nil {
				return err
			}
			return s.applyProfile(ctx, tx, userID, ident, in.FullName)
		}

		// 2. Anonymous Bearer in play → upgrade that user.
		if uid, ok := s.userFromBearer(in.BearerAccess); ok && isAnonymousClaim(in.BearerAccess, s.Verifier) {
			userID = uid
			return s.createIdentity(ctx, tx, provider, ident, uid, in.FullName)
		}

		// 3. Cross-link by verified email.
		if ident.EmailVerified && ident.Email != "" {
			matchUID, err := s.Identities.FindUserByVerifiedEmail(ctx, ident.Email)
			if err != nil {
				return err
			}
			if matchUID != uuid.Nil {
				userID = matchUID
				return s.createIdentity(ctx, tx, provider, ident, matchUID, in.FullName)
			}
		}

		// 4. Fresh user.
		uid, err := s.Users.Create(ctx, tx)
		if err != nil {
			return err
		}
		userID = uid
		return s.createIdentity(ctx, tx, provider, ident, uid, in.FullName)
	})
	if err != nil {
		return nil, fmt.Errorf("signin %s: %w", provider, err)
	}
	return s.issueSession(ctx, userID, false, in.DeviceID)
}

func (s *Service) createIdentity(ctx context.Context, tx pgx.Tx, provider string, ident *providers.Identity, userID uuid.UUID, fullName string) error {
	row := store.Identity{
		Provider:      provider,
		Subject:       ident.Subject,
		UserID:        userID,
		EmailVerified: ident.EmailVerified,
	}
	if ident.Email != "" {
		em := ident.Email
		row.Email = &em
	}
	if err := s.Identities.Create(ctx, tx, row); err != nil {
		return err
	}
	return s.applyProfile(ctx, tx, userID, ident, fullName)
}

// applyProfile is the single place that lands display name + avatar into
// auth.users. Name follows "set-if-empty" semantics (Apple's fullName is
// one-shot and we don't want a later Google login clobbering an existing
// custom name down the line). Picture is always overwritten when the
// provider hands one back — Google rotates avatar URLs, so the freshest
// wins. Apple's "no picture" path is a no-op rather than a NULL write.
func (s *Service) applyProfile(ctx context.Context, tx pgx.Tx, userID uuid.UUID, ident *providers.Identity, fullName string) error {
	name := ident.Name
	if name == "" {
		name = fullName
	}
	if name != "" {
		if err := s.Users.SetNameIfEmpty(ctx, tx, userID, name); err != nil {
			return err
		}
	}
	if ident.PictureURL != "" {
		if err := s.Users.SetPictureURL(ctx, tx, userID, ident.PictureURL); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) maybeUpdateIdentityEmail(ctx context.Context, tx pgx.Tx, existing *store.Identity, fresh *providers.Identity) error {
	freshEmail := emptyToNil(fresh.Email)
	// Skip write if nothing changed (Apple re-issues the same relay most of the time).
	if equalPtrStr(existing.Email, freshEmail) && existing.EmailVerified == fresh.EmailVerified {
		return nil
	}
	return s.Identities.UpdateEmail(ctx, tx, existing.Provider, existing.Subject, freshEmail, fresh.EmailVerified)
}

// ─── Refresh ────────────────────────────────────────────────────────────────

// Refresh rotates a single-use refresh token.
//
// Invariants:
//   - SELECT FOR UPDATE serializes concurrent /refresh calls.
//   - Old jti is marked revoked_at = now() in the same tx.
//   - Returned access carries the user's current anonymous flag (computed by
//     re-checking whether they still own any non-device identity).
func (s *Service) Refresh(ctx context.Context, refreshToken string) (*Session, error) {
	claims, err := s.Verifier.Verify(refreshToken)
	if err != nil {
		return nil, fmt.Errorf("refresh: invalid token: %w", err)
	}
	jti, err := claims.JTI()
	if err != nil {
		return nil, err
	}

	var session *Session
	err = pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		row, err := s.RefreshTokens.LockAndRotate(ctx, tx, jti)
		if err != nil {
			return err
		}
		if row == nil {
			return errors.New("unknown refresh token")
		}
		if row.RevokedAt != nil {
			return errors.New("refresh token revoked")
		}
		if time.Now().After(row.ExpiresAt) {
			return errors.New("refresh token expired")
		}

		// Mark the old row revoked and issue a fresh one.
		if err := s.RefreshTokens.MarkRevoked(ctx, tx, row.JTI); err != nil {
			return err
		}

		anonymous, err := s.userIsAnonymous(ctx, tx, row.UserID)
		if err != nil {
			return err
		}

		access, _, err := s.Signer.Issue(row.UserID, anonymous, AccessTTL, uuid.Nil)
		if err != nil {
			return err
		}
		newJTI := uuid.New()
		refresh, _, err := s.Signer.Issue(row.UserID, anonymous, RefreshTTL, newJTI)
		if err != nil {
			return err
		}
		if err := s.RefreshTokens.Create(ctx, tx, store.RefreshToken{
			JTI:       newJTI,
			UserID:    row.UserID,
			DeviceID:  row.DeviceID,
			ExpiresAt: time.Now().Add(RefreshTTL),
		}); err != nil {
			return err
		}
		session = &Session{
			AccessToken:  access,
			RefreshToken: refresh,
			UserID:       row.UserID,
			Anonymous:    anonymous,
		}
		return nil
	})
	return session, err
}

// ─── Signout ────────────────────────────────────────────────────────────────

// Signout revokes the given refresh token (this device only).
func (s *Service) Signout(ctx context.Context, refreshToken string) error {
	claims, err := s.Verifier.Verify(refreshToken)
	if err != nil {
		// Treat invalid token as no-op success — client gets logged out anyway.
		return nil
	}
	jti, err := claims.JTI()
	if err != nil {
		return nil
	}
	return pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		row, err := s.RefreshTokens.LockAndRotate(ctx, tx, jti)
		if err != nil || row == nil {
			return nil
		}
		return s.RefreshTokens.MarkRevoked(ctx, tx, jti)
	})
}

// ─── /auth/me ───────────────────────────────────────────────────────────────

type MeResponse struct {
	UserID     uuid.UUID    `json:"userId"`
	Email      *string      `json:"email"`
	Name       *string      `json:"name"`
	PictureURL *string      `json:"pictureUrl"`
	Anonymous  bool         `json:"anonymous"`
	Identities []MeIdentity `json:"identities"`
	CreatedAt  time.Time    `json:"createdAt"`
}

type MeIdentity struct {
	Provider      string    `json:"provider"`
	Subject       string    `json:"subject"`
	Email         *string   `json:"email"`
	EmailVerified bool      `json:"emailVerified"`
	CreatedAt     time.Time `json:"createdAt"`
}

func (s *Service) Me(ctx context.Context, userID uuid.UUID) (*MeResponse, error) {
	u, err := s.Users.Get(ctx, userID)
	if err != nil {
		return nil, err
	}
	if u == nil {
		return nil, errors.New("user not found")
	}
	idents, err := s.Identities.ListForUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	email, err := s.Identities.LatestVerifiedEmail(ctx, userID)
	if err != nil {
		return nil, err
	}
	anonymous, err := s.userIsAnonymous(ctx, nil, userID)
	if err != nil {
		return nil, err
	}
	resp := &MeResponse{
		UserID:     u.ID,
		Email:      email,
		Name:       u.Name,
		PictureURL: u.PictureURL,
		Anonymous:  anonymous,
		CreatedAt:  u.CreatedAt,
	}
	for _, i := range idents {
		resp.Identities = append(resp.Identities, MeIdentity{
			Provider:      i.Provider,
			Subject:       i.Subject,
			Email:         i.Email,
			EmailVerified: i.EmailVerified,
			CreatedAt:     i.CreatedAt,
		})
	}
	return resp, nil
}

// ─── Account delete ─────────────────────────────────────────────────────────

// DeleteAccount removes the user and everything that hangs off them:
//
//   - auth.identities + auth.refresh_tokens go via ON DELETE CASCADE on the
//     auth.users row.
//   - Rate-limit counters live in Redis with day-bucketed TTL (chat via
//     `RedisRateLimitStore`, share-video via `redislimit`). Orphan keys
//     expire within <24h after account delete — no explicit cleanup needed.
//   - Downstream cleanup outside this service's data (Langfuse traces, S3
//     prefixes, …) is NOT this service's job. The trigger installed by
//     migration 0023_outbox enqueues a `user.deleted` row into app.outbox in
//     the same transaction and pg_notify's the `outbox` channel; the
//     cleanup-worker service consumes from there.
func (s *Service) DeleteAccount(ctx context.Context, userID uuid.UUID) error {
	return pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		return s.Users.Delete(ctx, tx, userID)
	})
}

// ─── helpers ────────────────────────────────────────────────────────────────

// userIsAnonymous returns true iff the user has no non-device identities.
func (s *Service) userIsAnonymous(ctx context.Context, _ pgx.Tx, userID uuid.UUID) (bool, error) {
	idents, err := s.Identities.ListForUser(ctx, userID)
	if err != nil {
		return false, err
	}
	for _, i := range idents {
		if i.Provider != ProviderDevice {
			return false, nil
		}
	}
	return true, nil
}

// issueSession mints fresh access + refresh and persists the refresh row.
func (s *Service) issueSession(ctx context.Context, userID uuid.UUID, anonymous bool, deviceID string) (*Session, error) {
	access, _, err := s.Signer.Issue(userID, anonymous, AccessTTL, uuid.Nil)
	if err != nil {
		return nil, err
	}
	newJTI := uuid.New()
	refresh, _, err := s.Signer.Issue(userID, anonymous, RefreshTTL, newJTI)
	if err != nil {
		return nil, err
	}
	var dev *string
	if deviceID != "" {
		d := deviceID
		dev = &d
	}
	if err := s.RefreshTokens.Create(ctx, nil, store.RefreshToken{
		JTI:       newJTI,
		UserID:    userID,
		DeviceID:  dev,
		ExpiresAt: time.Now().Add(RefreshTTL),
	}); err != nil {
		return nil, err
	}
	return &Session{
		AccessToken:  access,
		RefreshToken: refresh,
		UserID:       userID,
		Anonymous:    anonymous,
	}, nil
}

// userFromBearer attempts to decode a Bearer access token; returns the user id
// only if signature + exp validate. The boolean signals validity.
func (s *Service) userFromBearer(bearer string) (uuid.UUID, bool) {
	if bearer == "" {
		return uuid.Nil, false
	}
	claims, err := s.Verifier.Verify(bearer)
	if err != nil {
		return uuid.Nil, false
	}
	uid, err := claims.UserID()
	if err != nil {
		return uuid.Nil, false
	}
	return uid, true
}

// isAnonymousClaim returns true if the verified Bearer carried `anonymous: true`.
func isAnonymousClaim(bearer string, v *jwt.Verifier) bool {
	if bearer == "" {
		return false
	}
	c, err := v.Verify(bearer)
	if err != nil {
		return false
	}
	return c.Anonymous
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
