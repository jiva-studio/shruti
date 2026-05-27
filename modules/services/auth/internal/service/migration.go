package service

// Wave 4 / PR-2a — cross-region account migration.
//
// MigrateIn rebuilds the user + identities on the destination region from
// the claims of a JWT issued by ANY trusted region. MigrateRevoke deletes
// the user from the source region after the destination has accepted
// the handover. The "JWT-as-proof" contract relies on:
//
//   - The multi-kid verifier in jwt.NewVerifierFromDir already trusting
//     every region's public key (operator rsync's *.pub.pem between boxes).
//   - claims.Identities + claims.RCAppUserID + claims.Tier(+expiry)
//     populated by ProfilePolicy.BuildClaims since PR-1 (Wave 2).
//
// Caveat on email reconstruction: the migrate-in JWT carries EmailHash
// (sha256 of the lowercased+trimmed address), NOT plaintext. The
// destination region cannot recover the plaintext from the hash, so
// auth.identities.email is inserted as NULL on the migrated rows. The
// next time the user signs in directly through Google/Apple on the
// destination, signinSocial repopulates the column via the existing
// maybeUpdateIdentityEmail path. /auth/me cascades to "signedIn"
// when email+name are both NULL — visible degradation only on the
// settings screen, no functional regression.

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/jiva-studio/shruti/auth/internal/jwt"
	"github.com/jiva-studio/shruti/auth/internal/store"
)

// ErrMigrateInAnonRejected is returned when the JWT's identities list
// contains only `provider="device"` rows. Anonymous accounts don't
// migrate — the mobile client falls back to a signOut + reboot in the
// new region (a fresh anon bootstrap), per the locked architectural
// decision in the multi-region plan.
var ErrMigrateInAnonRejected = errors.New("migrate-in: anonymous-only identities rejected")

// MigrateIn materialises a user + identities on this region from a
// JWT issued by another trusted region.
//
// Inputs:
//   - claims: already-verified bearer claims (caller ran VerifyAnyKid).
//   - deviceID: optional device id captured on the new refresh row so
//     the destination's refresh-token table mirrors the source shape.
//
// Idempotency: if a user with the same `sub` already exists locally
// (re-migration after a flaky network or a retried request) we skip the
// inserts and just issue a fresh session signed with our local kid.
// The caller cannot distinguish "fresh migrate-in" from "re-issued
// session" — intentional, the wire shape is identical.
//
// Rejection paths:
//   - empty/garbage sub                                  → error
//   - empty claims.Identities                            → error
//   - claims.Identities contains ONLY provider="device"  → ErrMigrateInAnonRejected
func (s *Service) MigrateIn(ctx context.Context, claims *jwt.Claims, deviceID string) (*Session, error) {
	if claims == nil || claims.Subject == "" {
		return nil, errors.New("migrate-in: missing sub")
	}
	if len(claims.Identities) == 0 {
		return nil, errors.New("migrate-in: no identities")
	}
	// Reject anonymous-only — anon migration uses the signOut+reboot
	// path. We don't try to preserve anon state across regions because
	// the local anon TTL cron will clean the source-region row up on
	// its own schedule.
	allAnon := true
	for _, id := range claims.Identities {
		if id.Provider != ProviderDevice {
			allAnon = false
			break
		}
	}
	if allAnon {
		return nil, ErrMigrateInAnonRejected
	}

	userID, err := uuid.Parse(claims.Subject)
	if err != nil {
		return nil, fmt.Errorf("migrate-in: bad sub %q: %w", claims.Subject, err)
	}

	err = pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		// Idempotent: row already present → we're re-issuing tokens to a
		// client that retried mid-flight. The bearer was signed by some
		// other region, but the local row exists from a prior migrate-in,
		// so the migration is effectively done. No-op the inserts.
		existing, err := s.Users.GetTx(ctx, tx, userID)
		if err != nil {
			return err
		}
		if existing != nil {
			return nil
		}

		// Anon-conflict resolution: this region may already hold a row in
		// auth.identities with the same (provider, subject) under a
		// DIFFERENT user_id. Common when the user installed the app fresh
		// on this region before migrating their real account in from
		// elsewhere (the cold-boot anonymous bootstrap stamps the device
		// identity on a throwaway user). Without this fixup the identity
		// insert below would fail on the (provider, subject) unique
		// constraint and surface as a 500 to the caller — exact repro on
		// 2026-05-27, request 81c494d0-c83e-4692-8119-56782b76b304.
		//
		// If the conflicting user has ONLY device identities we drop
		// them (the FK CASCADE wipes identities + refresh_tokens) so the
		// migration can proceed. If they have a real identity
		// (google/apple) the dest region already owns a non-anonymous
		// account for this person — that's a duplicate-account state the
		// proactive cross-region probe at signin (#708) is supposed to
		// prevent; refuse the migration here rather than silently
		// stealing identities from a real account.
		for _, id := range claims.Identities {
			existingIdent, err := s.Identities.GetTx(ctx, tx, id.Provider, id.Subject)
			if err != nil {
				return fmt.Errorf("lookup conflicting identity %s/%s: %w", id.Provider, id.Subject, err)
			}
			if existingIdent == nil || existingIdent.UserID == userID {
				continue
			}
			others, err := s.Identities.ListForUserTx(ctx, tx, existingIdent.UserID)
			if err != nil {
				return fmt.Errorf("list identities for conflicting user %s: %w", existingIdent.UserID, err)
			}
			anonOnly := true
			for _, oi := range others {
				if oi.Provider != ProviderDevice {
					anonOnly = false
					break
				}
			}
			if !anonOnly {
				return fmt.Errorf(
					"migrate-in: identity %s/%s already bound to non-anonymous user %s on this region",
					id.Provider, id.Subject, existingIdent.UserID,
				)
			}
			if _, err := s.Users.Delete(ctx, tx, existingIdent.UserID); err != nil {
				return fmt.Errorf("clear conflicting anon user %s: %w", existingIdent.UserID, err)
			}
		}

		if err := s.Users.InsertForMigration(ctx, tx, store.MigrateUser{
			ID:            userID,
			Tier:          claims.Tier,
			TierExpiresAt: tierExpiresAtFromClaim(claims),
			RCAppUserID:   nilIfEmpty(claims.RCAppUserID),
			HomeRegion:    s.RegionID,
		}); err != nil {
			return fmt.Errorf("insert user: %w", err)
		}
		for _, id := range claims.Identities {
			// EmailHash is one-way; we can't reconstruct plaintext. The
			// row is inserted with email=NULL; a future direct sign-in
			// repopulates it via maybeUpdateIdentityEmail. EmailVerified
			// is preserved from the claim so the eventual repopulate
			// path can short-circuit when the provider re-asserts the
			// same verified address.
			if err := s.Identities.Create(ctx, tx, store.Identity{
				Provider:      id.Provider,
				Subject:       id.Subject,
				UserID:        userID,
				Email:         nil,
				EmailVerified: id.EmailVerified,
				HomeRegion:    s.RegionID,
			}); err != nil {
				return fmt.Errorf("insert identity %s/%s: %w", id.Provider, id.Subject, err)
			}
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("migrate-in tx: %w", err)
	}

	// Issue a fresh session with our local kid. The migrated user is
	// non-anonymous by construction (we just rejected anon-only above).
	return s.issueSession(ctx, userID, false /*anonymous*/, deviceID)
}

// MigrateRevoke deletes the user row on this region after a successful
// migrate-in on the destination. The bearer MUST have been signed by a
// kid other than our own: if we signed it, no migration is in flight —
// the client is just confused (or malicious) and would otherwise lock
// themselves out by deleting the very session they're holding.
//
// On success, the auth.users delete cascades to identities +
// refresh_tokens via FK ON DELETE CASCADE, and the existing
// app.emit_user_deleted trigger enqueues a user.deleted outbox event
// in the same tx → cleanup-worker fans out the standard Langfuse +
// downstream purge.
//
// Idempotent: revoking an already-gone user returns nil. Two retries
// of the destination's revoke schedule (mobile's schedulePendingRevoke)
// must not 500 the client out of completing the migration.
func (s *Service) MigrateRevoke(ctx context.Context, claims *jwt.Claims, signingKid string) error {
	if claims == nil || claims.Subject == "" {
		return errors.New("migrate-revoke: missing sub")
	}
	if s.LocalKid != "" && signingKid == s.LocalKid {
		return errors.New("migrate-revoke: refused — bearer signed by us, no migration in flight")
	}
	userID, err := uuid.Parse(claims.Subject)
	if err != nil {
		return fmt.Errorf("migrate-revoke: bad sub: %w", err)
	}
	// Same locking pattern as DeleteAccount: revoke refresh tokens
	// before dropping the user row so a concurrent /refresh on the
	// soon-to-be-gone account doesn't slip through with the pre-cascade
	// MVCC snapshot.
	return pgx.BeginFunc(ctx, s.Pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx,
			`UPDATE auth.refresh_tokens
			    SET revoked_at = now()
			  WHERE user_id = $1 AND revoked_at IS NULL`,
			userID,
		); err != nil {
			return fmt.Errorf("revoke refresh tokens: %w", err)
		}
		// rows==0 → user already gone (idempotent path); no error.
		if _, err := s.Users.Delete(ctx, tx, userID); err != nil {
			return err
		}
		return nil
	})
}

// tierExpiresAtFromClaim coerces the UNIX-epoch (seconds) `tier_expires_at`
// claim into a *time.Time. Zero / missing → nil (lifetime entitlements,
// or free tier). Non-zero past values are preserved as-is so the
// destination's loadTier coercion can demote stale Pro to free without
// dropping the column.
func tierExpiresAtFromClaim(c *jwt.Claims) *time.Time {
	if c == nil || c.TierExpiresAt == 0 {
		return nil
	}
	t := time.Unix(c.TierExpiresAt, 0).UTC()
	return &t
}

// nilIfEmpty returns nil for the empty string, else a pointer to a copy.
// Used for nullable text columns where "" must distinguish from a real
// value in the DB (rc_app_user_id, email, etc.).
func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	v := s
	return &v
}
