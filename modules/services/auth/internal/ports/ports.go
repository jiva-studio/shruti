// Package ports declares what the auth use cases ask of the world: the
// stores behind the auth schema, a unit of work over them, the token signer
// and verifier, the id-token verifiers of the sign-in providers, the mailer
// and RevenueCat.
package ports

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/auth/internal/domain/account"
	"github.com/jiva-studio/shruti/auth/internal/domain/subscription"
	"github.com/jiva-studio/shruti/authjwt"
)

// Users is the auth.users collection.
type Users interface {
	Create(ctx context.Context) (uuid.UUID, error)
	// Get returns nil, nil for an unknown id.
	Get(ctx context.Context, id uuid.UUID) (*account.User, error)
	// IDByRCAppUserID returns the user bound to a RevenueCat customer; ok is
	// false when none is.
	IDByRCAppUserID(ctx context.Context, appUserID string) (id uuid.UUID, ok bool, err error)
	// UpsertSubscriptionState writes the snapshot onto the user bound to its
	// customer unless that user already holds a newer one.
	UpsertSubscriptionState(ctx context.Context, snap subscription.Snapshot) (uuid.UUID, subscription.UpsertOutcome, error)
	// ListStaleSubscribers returns at most limit bound users whose tier state
	// was never synced or is older than staleAfter, the oldest first.
	ListStaleSubscribers(ctx context.Context, staleAfter time.Duration, limit int) ([]subscription.StaleSubscriber, error)
	// BindRCAppUserID binds the user to a customer unless it is bound already.
	BindRCAppUserID(ctx context.Context, userID uuid.UUID, appUserID string) error
	SetNameIfEmpty(ctx context.Context, id uuid.UUID, name string) error
	SetPictureURL(ctx context.Context, id uuid.UUID, url string) error
	// Delete removes the user with its identities and refresh tokens, and
	// enqueues user.deleted for downstream cleanup. It returns the number of
	// rows removed.
	Delete(ctx context.Context, id uuid.UUID) (int64, error)
}

// Identities is the auth.identities collection.
type Identities interface {
	// Get returns nil, nil for an unknown (provider, subject).
	Get(ctx context.Context, provider, subject string) (*account.Identity, error)
	// Create fails with account.ErrIdentityExists when (provider, subject) is
	// taken.
	Create(ctx context.Context, ident account.Identity) error
	UpdateEmail(ctx context.Context, provider, subject string, email *string, verified bool) error
	// FindUserByVerifiedEmail returns the oldest user holding an identity with
	// this verified email, uuid.Nil when none does.
	FindUserByVerifiedEmail(ctx context.Context, email string) (uuid.UUID, error)
	// ListForUser returns the user's identities, oldest first.
	ListForUser(ctx context.Context, userID uuid.UUID) ([]account.Identity, error)
	// LatestVerifiedEmail returns the newest verified email among the user's
	// identities, nil when there is none.
	LatestVerifiedEmail(ctx context.Context, userID uuid.UUID) (*string, error)
}

// RefreshTokens is the auth.refresh_tokens collection.
type RefreshTokens interface {
	Create(ctx context.Context, t account.RefreshToken) error
	// LockForRotation reads the token and holds its row lock until the unit
	// of work ends, serialising concurrent rotations; nil, nil when unknown.
	LockForRotation(ctx context.Context, jti uuid.UUID) (*account.RefreshToken, error)
	// MarkRevoked revokes a token without a successor (signout).
	MarkRevoked(ctx context.Context, jti uuid.UUID) error
	// MarkRevokedWithSuccessor revokes a token that was rotated into successor.
	MarkRevokedWithSuccessor(ctx context.Context, jti, successor uuid.UUID) error
	// RevokeAllForUser revokes every live token of the user, holding their
	// row locks until the unit of work ends.
	RevokeAllForUser(ctx context.Context, userID uuid.UUID) error
}

// WebhookEvents is the auth.rc_webhook_events ledger of RevenueCat
// deliveries.
type WebhookEvents interface {
	// LookupProcessed reports whether the event is recorded as processed.
	LookupProcessed(ctx context.Context, eventID string) (bool, error)
	// InsertOrLookup records a first delivery (inserted) or reports whether
	// an earlier delivery was processed, in one atomic step.
	InsertOrLookup(ctx context.Context, eventID, appUserID string) (inserted, processed bool, err error)
	MarkProcessed(ctx context.Context, eventID string) error
	// RecordError stores msg on an event that is not processed yet.
	RecordError(ctx context.Context, eventID, msg string) error
	// ListOrphanedOlderThan returns at most limit unprocessed events with a
	// customer id received more than olderThan ago, the oldest first.
	ListOrphanedOlderThan(ctx context.Context, olderThan time.Duration, limit int) ([]subscription.OrphanedEvent, error)
	// MarkOrphaned seals an unprocessed event as orphaned_no_link.
	MarkOrphaned(ctx context.Context, eventID string) error
}

// EmailCodes holds the pending passwordless sign-in code of each address,
// with the address's rolling 24h verify-attempt count.
type EmailCodes interface {
	// UpsertIfCooledDown stores a fresh code unless one was sent less than
	// cooldown ago, deciding and writing in one step; false when throttled.
	// The code gets what is left of the window's maxPerWindow attempts, at
	// most maxPerCode and never fewer than one.
	UpsertIfCooledDown(ctx context.Context, email, codeHash string, expiresAt time.Time, cooldown time.Duration, maxPerCode, maxPerWindow int) (bool, error)
	// ConsumeAttempt claims one of the code's verify attempts and returns the
	// stored hash; ok is false when no attempt is available.
	ConsumeAttempt(ctx context.Context, email string, maxPerCode int) (codeHash string, ok bool, err error)
	Delete(ctx context.Context, email string) error
	// DeleteExpired removes expired codes whose attempt window is closed.
	DeleteExpired(ctx context.Context) (int64, error)
}

// SubscriptionGrants pins the target expiry of an idempotent promotional
// grant.
type SubscriptionGrants interface {
	// Reserve stores desired under grantKey on first call and returns the
	// stored expiry on every call.
	Reserve(ctx context.Context, grantKey string, userID uuid.UUID, duration string, desired time.Time) (time.Time, error)
}

// Outbox enqueues events for downstream consumers.
type Outbox interface {
	// EmitSubscriptionChanged enqueues subscription.changed for the user; a
	// second emission for the same source event is dropped.
	EmitSubscriptionChanged(ctx context.Context, userID uuid.UUID, payload []byte, sourceEventID string) error
}

// Store is every collection, bound either to the pool or to one unit of
// work.
type Store interface {
	Users() Users
	Identities() Identities
	RefreshTokens() RefreshTokens
	WebhookEvents() WebhookEvents
	EmailCodes() EmailCodes
	SubscriptionGrants() SubscriptionGrants
	Outbox() Outbox
	// LockSubscriber serialises work on one RevenueCat customer until the
	// unit of work ends.
	LockSubscriber(ctx context.Context, appUserID string) error
}

// UnitOfWork runs fn in one transaction: fn's writes through tx commit
// together when it returns nil and roll back when it returns an error.
type UnitOfWork interface {
	Do(ctx context.Context, fn func(tx Store) error) error
}

// TokenSigner issues the service's tokens.
type TokenSigner interface {
	Issue(in authjwt.IssueInput) (token string, jti uuid.UUID, err error)
}

// TokenVerifier verifies the service's tokens, one method per kind.
type TokenVerifier interface {
	VerifyAccess(token string) (*authjwt.Claims, error)
	VerifyRefresh(token string) (*authjwt.Claims, error)
}

// IDTokenVerifier verifies a sign-in provider's id token.
type IDTokenVerifier interface {
	Verify(ctx context.Context, idToken string) (*account.ProviderIdentity, error)
}

// Mailer delivers an email with a plain-text and an HTML body.
type Mailer interface {
	Send(ctx context.Context, to, subject, text, html string) error
}

// RevenueCat reads a customer and grants promotional entitlements. Its
// errors are classified by the subscription package's sentinels.
type RevenueCat interface {
	GetSubscriber(ctx context.Context, appUserID string) (*subscription.Customer, error)
	GrantPromotional(ctx context.Context, appUserID, entitlementID string, endTimeMs int64) error
}
