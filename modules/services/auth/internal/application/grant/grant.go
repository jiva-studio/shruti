// Package grant gives a user Pro through a RevenueCat promotional
// entitlement — what a purchase outside the app stores (crypto billing)
// turns into — and reflects it as tier=pro at once.
package grant

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/auth/internal/application/rcsync"
	"github.com/jiva-studio/shruti/auth/internal/domain/account"
	"github.com/jiva-studio/shruti/auth/internal/domain/subscription"
	"github.com/jiva-studio/shruti/auth/internal/ports"
)

// ErrUserNotFound is returned when no user has the given id.
var ErrUserNotFound = errors.New("grant: user not found")

// Service grants Pro. ProEntitlement is the RevenueCat entitlement id,
// "pro" when blank.
type Service struct {
	Store          ports.Store
	RC             ports.RevenueCat
	Sync           *rcsync.Service
	ProEntitlement string
	Now            func() time.Time
}

// GrantAndApply grants a promotional Pro entitlement and applies the
// resulting state right away: RevenueCat sends no webhook for a promotional
// grant, and the reconcile pass is only a slow backstop.
//
// Steps:
//  1. Bind the user to the customer id userID.String() (idempotent).
//  2. GET the subscriber first — RevenueCat answers 404 to a grant for a
//     subscriber it has never seen (a web-only user), and the GET creates
//     it. The GET also yields the current expiry.
//  3. New expiry = max(now, current expiry) + period, so a renewal extends
//     rather than resets (a grant replaces the expiry).
//  4. Grant with that absolute end time, refetch, and apply under a
//     synthetic event id.
//
// duration is the purchased plan: "monthly" or "yearly".
//
// grantKey makes the grant idempotent across re-drives (the billing
// reconcile worker re-running an order whose first response was lost after
// RevenueCat applied it). The end time computed on the first attempt is
// stored under grantKey and reused on every re-drive, so re-applying
// replaces the expiry with the same value instead of stacking another
// period. An empty grantKey is not idempotent.
func (s *Service) GrantAndApply(ctx context.Context, userID uuid.UUID, duration, grantKey string) error {
	u, err := s.Store.Users().Get(ctx, userID)
	if err != nil {
		return err
	}
	if u == nil {
		return ErrUserNotFound
	}

	appUserID := userID.String()
	if err := s.Store.Users().BindRCAppUserID(ctx, userID, appUserID); err != nil {
		return fmt.Errorf("grant: bind rc: %w", err)
	}

	entitlement := s.ProEntitlement
	if entitlement == "" {
		entitlement = account.TierPro
	}

	now := s.Now().UTC()
	pre, err := s.RC.GetSubscriber(ctx, appUserID)
	if err != nil && !errors.Is(err, subscription.ErrSubscriberNotFound) {
		return fmt.Errorf("grant: pre-fetch: %w", err)
	}
	base := now
	if pre != nil && pre.Subscriber != nil {
		if ent, ok := pre.Subscriber.Entitlements[entitlement]; ok &&
			ent.ExpiresDate != nil && ent.ExpiresDate.After(base) {
			base = *ent.ExpiresDate
		}
	}

	var end time.Time
	switch duration {
	case "monthly":
		end = base.AddDate(0, 1, 0)
	case "yearly":
		end = base.AddDate(1, 0, 0)
	default:
		return fmt.Errorf("grant: unsupported duration %q", duration)
	}

	// Pin the end time under grantKey before touching RevenueCat: a re-drive
	// gets the first attempt's end back and re-applies the same expiry.
	eventID := fmt.Sprintf("billing-grant:%s:%s:%d", userID, duration, s.Now().Unix())
	if grantKey != "" {
		stored, err := s.Store.SubscriptionGrants().Reserve(ctx, grantKey, userID, duration, end)
		if err != nil {
			return fmt.Errorf("grant: reserve: %w", err)
		}
		end = stored
		// A stable event id dedups the outbox emission too: one event per
		// order, not one per attempt.
		eventID = "billing-grant:" + grantKey
	}

	if err := s.RC.GrantPromotional(ctx, appUserID, entitlement, end.UnixMilli()); err != nil {
		return fmt.Errorf("grant: %w", err)
	}

	snap, err := s.Sync.FetchSnapshot(ctx, appUserID)
	if err != nil {
		return fmt.Errorf("grant: refetch: %w", err)
	}
	if _, _, err := s.Sync.Apply(ctx, eventID, snap); err != nil {
		return fmt.Errorf("grant: apply: %w", err)
	}
	return nil
}
