// Package service implements the business logic of the auth API.
//
// Tokens layout:
//   - access  — 15 min, signed (RS256, kid=v1), payload includes `anonymous`
//   - refresh — 90 days, signed too, single-use; refresh rotates jti and
//     marks the previous row revoked under SELECT … FOR UPDATE.
package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/akdasa-studios/lectorium/auth/internal/identityhash"
	"github.com/akdasa-studios/lectorium/auth/internal/jwt"
	"github.com/akdasa-studios/lectorium/auth/internal/profile"
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
	Pool           *pgxpool.Pool
	Users          *store.UserRepo
	Identities     *store.IdentityRepo
	RefreshTokens  *store.RefreshTokenRepo
	WebhookEvents  *store.WebhookEventRepo
	Signer         *jwt.Signer
	Verifier       *jwt.Verifier
	GoogleVerifier ProviderVerifier
	AppleVerifier  ProviderVerifier
	// ProfilePolicy gates which optional profile fields land in JWT
	// claims and storage. Zero-value (every field disabled) is safe
	// for tests that don't care about claim filtering — emits no
	// EmailHash / EmailVerified. Production sets it from config.yaml
	// at boot, indexed by PROFILE env (global vs ru).
	ProfilePolicy profile.ProfilePolicy
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
//
// The raw OAuth payload is filtered through ProfilePolicy.FromOAuth before
// any DB write so suppressed fields (email/name/avatar in RU profile) never
// reach the persistence layer. Provider + Subject always survive — the
// identity row needs them to bind. When the deployment doesn't collect
// email, the cross-link-by-verified-email branch is skipped: Google and
// Apple on the same human become two separate accounts. Acceptable
// simplification per the locked architectural decision.
func (s *Service) signinSocial(ctx context.Context, provider string, ident *providers.Identity, in SocialInput) (*Session, error) {
	if ident.Subject == "" {
		return nil, fmt.Errorf("%s: empty subject", provider)
	}

	// Apple's fullName is one-shot in the signin request body (only the
	// first time the user grants the app). Fold it into the OAuth payload
	// here so the policy filter sees a uniform shape.
	rawName := ident.Name
	if rawName == "" {
		rawName = in.FullName
	}
	filtered := s.ProfilePolicy.FromOAuth(profile.OAuthIdentityData{
		Provider:      provider,
		Subject:       ident.Subject,
		Email:         ident.Email,
		EmailVerified: ident.EmailVerified,
		Name:          rawName,
		AvatarURL:     ident.PictureURL,
	})

	var userID uuid.UUID
	err := pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		// 1. Existing identity?  Same user, just refresh email if changed.
		existing, err := s.Identities.Get(ctx, provider, ident.Subject)
		if err != nil {
			return err
		}
		if existing != nil {
			userID = existing.UserID
			if err := s.maybeUpdateIdentityEmail(ctx, tx, existing, filtered); err != nil {
				return err
			}
			return s.applyProfile(ctx, tx, userID, filtered)
		}

		// 2. Anonymous Bearer in play → upgrade that user.
		if uid, ok := s.userFromBearer(in.BearerAccess); ok && isAnonymousClaim(in.BearerAccess, s.Verifier) {
			userID = uid
			return s.createIdentity(ctx, tx, uid, filtered)
		}

		// 3. Cross-link by verified email — only useful if this
		//    deployment collects email at all. With email disabled,
		//    Google + Apple on the same human produce two separate
		//    user rows; the user's tier travels with whichever they
		//    signed in with first, and the duplicate is harmless.
		if s.ProfilePolicy.Email.Enabled && filtered.EmailVerified && filtered.Email != "" {
			matchUID, err := s.Identities.FindUserByVerifiedEmail(ctx, filtered.Email)
			if err != nil {
				return err
			}
			if matchUID != uuid.Nil {
				userID = matchUID
				return s.createIdentity(ctx, tx, matchUID, filtered)
			}
		}

		// 4. Fresh user.
		uid, err := s.Users.Create(ctx, tx)
		if err != nil {
			return err
		}
		userID = uid
		return s.createIdentity(ctx, tx, uid, filtered)
	})
	if err != nil {
		return nil, fmt.Errorf("signin %s: %w", provider, err)
	}
	// Mobile-side Purchases.logIn(JWT sub) makes appUserID == userID.
	// Idempotent UPDATE — only writes when the column is NULL, so
	// subsequent signins are a no-op. Without this, the RC webhook's
	// UPDATE WHERE rc_app_user_id = ... never matches and the row
	// gets stamped orphaned_no_link by the 7-day sweep.
	if err := s.Users.BindRCAppUserID(ctx, nil, userID, userID.String()); err != nil {
		return nil, fmt.Errorf("signin %s: bind rc: %w", provider, err)
	}
	return s.issueSession(ctx, userID, false, in.DeviceID)
}

// createIdentity inserts an auth.identities row for `userID` from a
// policy-filtered OAuth payload. When the policy suppressed the email
// the row is created with email=NULL, email_verified=false — same shape
// as a provider that simply didn't return one.
func (s *Service) createIdentity(ctx context.Context, tx pgx.Tx, userID uuid.UUID, f profile.FilteredIdentity) error {
	row := store.Identity{
		Provider:      f.Provider,
		Subject:       f.Subject,
		UserID:        userID,
		EmailVerified: f.EmailVerified,
	}
	if f.Email != "" {
		em := f.Email
		row.Email = &em
	}
	if err := s.Identities.Create(ctx, tx, row); err != nil {
		return err
	}
	return s.applyProfile(ctx, tx, userID, f)
}

// applyProfile is the single place that lands display name + avatar into
// auth.users from a policy-filtered OAuth payload. Name follows "set-if-
// empty" semantics (Apple's fullName is one-shot and we don't want a
// later Google login clobbering an existing custom name down the line).
// Picture is always overwritten when the provider hands one back —
// Google rotates avatar URLs, so the freshest wins. Empty input (either
// the provider didn't return the field, or the policy suppressed it) is
// a no-op rather than a NULL write.
func (s *Service) applyProfile(ctx context.Context, tx pgx.Tx, userID uuid.UUID, f profile.FilteredIdentity) error {
	if f.Name != "" {
		if err := s.Users.SetNameIfEmpty(ctx, tx, userID, f.Name); err != nil {
			return err
		}
	}
	if f.AvatarURL != "" {
		if err := s.Users.SetPictureURL(ctx, tx, userID, f.AvatarURL); err != nil {
			return err
		}
	}
	return nil
}

// maybeUpdateIdentityEmail refreshes an existing identity row's email
// only when the policy collects email AND the value actually changed
// (Apple re-issues the same relay most of the time). With email
// suppressed by the policy the call is a no-op — we don't write NULL
// over a pre-existing address either, because the row was created under
// the same policy and already matches.
func (s *Service) maybeUpdateIdentityEmail(ctx context.Context, tx pgx.Tx, existing *store.Identity, f profile.FilteredIdentity) error {
	if !s.ProfilePolicy.Email.Enabled {
		return nil
	}
	freshEmail := emptyToNil(f.Email)
	if equalPtrStr(existing.Email, freshEmail) && existing.EmailVerified == f.EmailVerified {
		return nil
	}
	return s.Identities.UpdateEmail(ctx, tx, existing.Provider, existing.Subject, freshEmail, f.EmailVerified)
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
		tier, tierExp, err := s.loadTierAndExpiry(ctx, row.UserID, time.Now().UTC())
		if err != nil {
			return fmt.Errorf("load tier: %w", err)
		}
		quotaID, err := s.loadQuotaID(ctx, row.UserID)
		if err != nil {
			return fmt.Errorf("load quota_id: %w", err)
		}
		idents, err := s.loadIdentities(ctx, row.UserID)
		if err != nil {
			return fmt.Errorf("load identities: %w", err)
		}
		rcAppUserID, err := s.loadRCAppUserID(ctx, row.UserID)
		if err != nil {
			return fmt.Errorf("load rc_app_user_id: %w", err)
		}
		base := s.ProfilePolicy.BuildClaims(row.UserID, anonymous, tier, tierExp, quotaID, rcAppUserID, idents)

		accessIn := base
		accessIn.Audience = jwt.AudienceChat
		accessIn.TTL = AccessTTL
		access, _, err := s.Signer.Issue(accessIn)
		if err != nil {
			return err
		}
		newJTI := uuid.New()
		refreshIn := base
		refreshIn.Audience = jwt.AudienceAuth
		refreshIn.TTL = RefreshTTL
		refreshIn.JTI = newJTI
		refresh, _, err := s.Signer.Issue(refreshIn)
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

// MeResponse and MeIdentity are the wire types of /auth/me. They are
// thin re-exports of profile.MeUser / profile.MeIdentity so the policy
// package owns the single source of truth for the response shape.
// Existing handler code constructs neither directly — Me() builds them
// via ProfilePolicy.ProjectMe.
type MeResponse = profile.MeUser
type MeIdentity = profile.MeIdentity

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
	tier := u.Tier
	if tier == "" {
		tier = TierFree
	}
	// View-side coerce: a stale Pro row whose expiry slid into the past
	// must not be reported as Pro to the client. The DB stays as-is
	// (reconcile cron / next webhook fixes the column); the JWT and /me
	// response always reflect "real now". Lifetime entitlements
	// (TierExpiresAt == nil) keep the original tier.
	if tier == TierPro && u.TierExpiresAt != nil && !u.TierExpiresAt.After(time.Now().UTC()) {
		tier = TierFree
	}

	src := profile.SourceUser{
		UserID:        u.ID,
		Anonymous:     anonymous,
		CreatedAt:     u.CreatedAt,
		Tier:          tier,
		TierExpiresAt: u.TierExpiresAt,
		Email:         derefStr(email),
		Name:          derefStr(u.Name),
		PictureURL:    derefStr(u.PictureURL),
		// Locale column not yet on auth.users (PR-1.5e); empty string
		// causes ProjectMe to omit the field regardless of policy.
		Locale: "",
	}
	src.Identities = make([]profile.SourceIdentity, 0, len(idents))
	for _, i := range idents {
		src.Identities = append(src.Identities, profile.SourceIdentity{
			Provider:      i.Provider,
			Subject:       i.Subject,
			Email:         derefStr(i.Email),
			EmailVerified: i.EmailVerified,
			CreatedAt:     i.CreatedAt,
		})
	}
	resp := s.ProfilePolicy.ProjectMe(src)
	return &resp, nil
}

func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// ─── Account delete ─────────────────────────────────────────────────────────

// ErrUserAlreadyDeleted is returned by DeleteAccount when the DELETE
// affected zero rows — i.e. the user id is unknown OR a previous concurrent
// delete already removed it. The handler maps this to 410 Gone so a client
// double-tapping "Delete account" doesn't see a misleading 200.
var ErrUserAlreadyDeleted = errors.New("user already deleted")

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
//
// Concurrency contract: BEFORE deleting auth.users we explicitly revoke all
// of the user's refresh tokens with a single UPDATE. That UPDATE takes
// row-level locks on every refresh_tokens row for the user. A concurrent
// /auth/refresh sitting in LockAndRotate on one of those jtis will block
// until our tx commits, then observe revoked_at != NULL and reject the
// rotation. Without this step, MVCC could let the in-flight refresh see
// the pre-cascade snapshot and issue a fresh token after the user row is
// already gone — a stranded session that outlives its account.
func (s *Service) DeleteAccount(ctx context.Context, userID uuid.UUID) error {
	return pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx,
			`UPDATE auth.refresh_tokens
			    SET revoked_at = now()
			  WHERE user_id = $1 AND revoked_at IS NULL`,
			userID,
		); err != nil {
			return fmt.Errorf("revoke refresh tokens: %w", err)
		}
		rows, err := s.Users.Delete(ctx, tx, userID)
		if err != nil {
			return err
		}
		if rows == 0 {
			return ErrUserAlreadyDeleted
		}
		return nil
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

// loadTierAndExpiry reads the user's subscription tier + UNIX-epoch
// expiry from auth.users in one round trip and returns a view-only
// coercion: if `tier_expires_at` is in the past, the returned tier is
// "free" regardless of what the column says. Defence-in-depth against
// a dropped EXPIRATION webhook leaving stale `tier="pro"` until the
// next reconcile cycle.
//
// Lifetime entitlements (tier="pro", tier_expires_at IS NULL) pass
// through as-is — they never expire.
//
// Does NOT mutate auth.users. The DB-side correction is the
// reconcile cron's job; this function just keeps the issued JWT from
// lying to the chat service.
func (s *Service) loadTierAndExpiry(ctx context.Context, userID uuid.UUID, now time.Time) (tier string, expiresAtEpoch int64, err error) {
	u, err := s.Users.Get(ctx, userID)
	if err != nil {
		return TierFree, 0, err
	}
	if u == nil || u.Tier == "" {
		return TierFree, 0, nil
	}
	tier = u.Tier
	if u.TierExpiresAt != nil {
		expiresAtEpoch = u.TierExpiresAt.Unix()
		if tier == TierPro && !u.TierExpiresAt.After(now) {
			tier = TierFree
		}
	}
	return tier, expiresAtEpoch, nil
}

// loadQuotaID derives the rate-limit key for `userID`. See
// internal/identityhash for the algorithm. Non-empty for every user
// since PR-1 (device-only / anonymous users get a peppered per-device
// hash).
func (s *Service) loadQuotaID(ctx context.Context, userID uuid.UUID) (string, error) {
	idents, err := s.Identities.ListForUser(ctx, userID)
	if err != nil {
		return "", err
	}
	return identityhash.Compute(idents), nil
}

// LookupResult is the no-side-effects result of /auth/lookup. It says
// whether a (provider, subject) pair is currently bound to any user
// and, if so, whether that user is anonymous. Used by mobile's
// retry-other-region flow (PR-3) — never issues tokens, never mutates
// state.
type LookupResult struct {
	Exists    bool
	Anonymous bool
}

// LookupSignin verifies the OAuth id-token to extract its `sub` and
// then returns the LookupResult for that (provider, sub). No DB
// writes, no token issuance. Powers the `X-Lookup-Only: 1` shortcut
// on /auth/signin/{google,apple}: callers can probe "do I already
// exist on this region?" without paying the signin bootstrap cost.
func (s *Service) LookupSignin(ctx context.Context, provider, idToken string) (LookupResult, error) {
	var verifier ProviderVerifier
	switch provider {
	case ProviderGoogle:
		verifier = s.GoogleVerifier
	case ProviderApple:
		verifier = s.AppleVerifier
	default:
		return LookupResult{}, fmt.Errorf("unsupported provider %q", provider)
	}
	ident, err := verifier.Verify(ctx, idToken)
	if err != nil {
		return LookupResult{}, fmt.Errorf("%s verify: %w", provider, err)
	}
	if ident.Subject == "" {
		return LookupResult{}, fmt.Errorf("%s: empty subject", provider)
	}
	return s.FindUserByProviderSubject(ctx, provider, ident.Subject)
}

// FindUserByProviderSubject resolves a (provider, subject) pair to a
// LookupResult. Returns `{Exists: false}` when no identity matches.
// Bounded by the (provider, subject) PK on auth.identities (and the
// supporting index from migration 0028) — O(log n) regardless of
// table size.
func (s *Service) FindUserByProviderSubject(ctx context.Context, provider, subject string) (LookupResult, error) {
	ident, err := s.Identities.Get(ctx, provider, subject)
	if err != nil {
		return LookupResult{}, err
	}
	if ident == nil {
		return LookupResult{}, nil
	}
	anon, err := s.userIsAnonymous(ctx, nil, ident.UserID)
	if err != nil {
		return LookupResult{}, err
	}
	return LookupResult{Exists: true, Anonymous: anon}, nil
}

// loadIdentities returns the user's identities shaped for the JWT
// `ids` claim. Email is hashed (sha256 of lower+trimmed) so the raw
// address never enters a token. Whether EmailHash / EmailVerified are
// actually emitted to the wire is decided downstream by
// ProfilePolicy.BuildClaims.
func (s *Service) loadIdentities(ctx context.Context, userID uuid.UUID) ([]jwt.ClaimIdentity, error) {
	rows, err := s.Identities.ListForUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := make([]jwt.ClaimIdentity, 0, len(rows))
	for _, r := range rows {
		ci := jwt.ClaimIdentity{
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
	return out, nil
}

// loadRCAppUserID returns the user's mirrored RC app_user_id, or ""
// if it hasn't been bound yet (signin not completed, or webhook
// arrived before Purchases.logIn).
func (s *Service) loadRCAppUserID(ctx context.Context, userID uuid.UUID) (string, error) {
	u, err := s.Users.Get(ctx, userID)
	if err != nil {
		return "", err
	}
	if u == nil || u.RCAppUserID == nil {
		return "", nil
	}
	return *u.RCAppUserID, nil
}

// issueSession mints fresh access + refresh and persists the refresh row.
func (s *Service) issueSession(ctx context.Context, userID uuid.UUID, anonymous bool, deviceID string) (*Session, error) {
	tier, tierExp, err := s.loadTierAndExpiry(ctx, userID, time.Now().UTC())
	if err != nil {
		return nil, fmt.Errorf("load tier: %w", err)
	}
	quotaID, err := s.loadQuotaID(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("load quota_id: %w", err)
	}
	idents, err := s.loadIdentities(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("load identities: %w", err)
	}
	rcAppUserID, err := s.loadRCAppUserID(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("load rc_app_user_id: %w", err)
	}
	base := s.ProfilePolicy.BuildClaims(userID, anonymous, tier, tierExp, quotaID, rcAppUserID, idents)

	accessIn := base
	accessIn.Audience = jwt.AudienceChat
	accessIn.TTL = AccessTTL
	access, _, err := s.Signer.Issue(accessIn)
	if err != nil {
		return nil, err
	}
	newJTI := uuid.New()
	refreshIn := base
	refreshIn.Audience = jwt.AudienceAuth
	refreshIn.TTL = RefreshTTL
	refreshIn.JTI = newJTI
	refresh, _, err := s.Signer.Issue(refreshIn)
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
