// Package account shows a signed-in user their account and deletes it.
package account

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	domain "github.com/jiva-studio/shruti/auth/internal/domain/account"
	"github.com/jiva-studio/shruti/auth/internal/domain/profile"
	"github.com/jiva-studio/shruti/auth/internal/ports"
)

// ErrUserAlreadyDeleted is returned by Delete when no user was removed: the
// id is unknown or a concurrent delete already removed it. The handler
// answers 410 Gone, so a double tap on "Delete account" does not see 200.
var ErrUserAlreadyDeleted = errors.New("user already deleted")

// Service reads and deletes accounts. Policy decides which optional profile
// fields /auth/me shows.
type Service struct {
	Store      ports.Store
	UnitOfWork ports.UnitOfWork
	Policy     profile.ProfilePolicy
	Now        func() time.Time
}

// Me returns the user as /auth/me shows them. A Pro whose expiry has passed
// shows as free; the stored row is corrected by the next webhook or
// reconcile pass, not here.
func (s *Service) Me(ctx context.Context, userID uuid.UUID) (*profile.Me, error) {
	u, err := s.Store.Users().Get(ctx, userID)
	if err != nil {
		return nil, err
	}
	if u == nil {
		return nil, errors.New("user not found")
	}
	idents, err := s.Store.Identities().ListForUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	email, err := s.Store.Identities().LatestVerifiedEmail(ctx, userID)
	if err != nil {
		return nil, err
	}
	src := profile.SourceUser{
		UserID:        u.ID,
		Anonymous:     domain.IsAnonymous(idents),
		CreatedAt:     u.CreatedAt,
		Tier:          domain.EffectiveTier(u.Tier, u.TierExpiresAt, s.Now().UTC()),
		TierExpiresAt: u.TierExpiresAt,
		Email:         derefStr(email),
		Name:          derefStr(u.Name),
		PictureURL:    derefStr(u.PictureURL),
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
	me := s.Policy.ProjectMe(src)
	return &me, nil
}

// Delete removes the user and everything that hangs off them: identities
// and refresh tokens by cascade, and a `user.deleted` outbox event for the
// cleanup worker (Langfuse traces, S3 prefixes and other data outside this
// service). Rate-limit counters in Redis expire on their own within a day.
//
// Before the user row goes, every refresh token of the user is revoked in
// the same unit of work, taking their row locks: a concurrent /auth/refresh
// holding one of them waits for the commit, then sees it revoked and
// refuses. Without that, the refresh could read the pre-delete snapshot and
// issue a session that outlives its account.
func (s *Service) Delete(ctx context.Context, userID uuid.UUID) error {
	return s.UnitOfWork.Do(ctx, func(tx ports.Store) error {
		if err := tx.RefreshTokens().RevokeAllForUser(ctx, userID); err != nil {
			return fmt.Errorf("revoke refresh tokens: %w", err)
		}
		rows, err := tx.Users().Delete(ctx, userID)
		if err != nil {
			return err
		}
		if rows == 0 {
			return ErrUserAlreadyDeleted
		}
		return nil
	})
}

func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
