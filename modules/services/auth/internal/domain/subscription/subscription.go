// Package subscription holds the Pro entitlement as the auth service mirrors
// it from RevenueCat: the customer record RevenueCat reports, and the
// snapshot of tier state derived from it and stored on the user.
package subscription

import (
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
)

// Snapshot is the tier state of one RevenueCat customer at SnapshotAt, the
// moment RevenueCat produced it on RevenueCat's clock, or zero when
// RevenueCat reported no time. A snapshot older than the one already
// applied to the user is never written over it, and a snapshot without a
// time never overrides a timed one.
type Snapshot struct {
	AppUserID     string
	Tier          string
	TierExpiresAt *time.Time
	SnapshotAt    time.Time
}

// UpsertOutcome says what applying a snapshot to the user did.
type UpsertOutcome int

const (
	// UpsertNoMatch — no user is bound to the snapshot's customer.
	UpsertNoMatch UpsertOutcome = iota
	// UpsertApplied — the snapshot was written.
	UpsertApplied
	// UpsertStale — the user already holds a newer snapshot.
	UpsertStale
)

// StaleSubscriber is a bound customer whose tier state is older than the
// reconcile pass allows.
type StaleSubscriber struct {
	UserID      uuid.UUID
	RCAppUserID string
}

// OrphanedEvent is a received webhook whose customer never became bound to
// a user.
type OrphanedEvent struct {
	EventID    string
	AppUserID  string
	ReceivedAt time.Time
}

// Customer is RevenueCat's record of one subscriber, as
// `GET /subscribers/{app_user_id}` reports it. Subscriber is nil when the
// body carried none. RequestDateMs is RevenueCat's server time for the
// answer (UNIX ms): the body's request_date_ms, else the response's Date
// header; 0 when RevenueCat sent neither.
type Customer struct {
	RequestDateMs int64
	Subscriber    *Subscriber
}

// Subscriber is the `subscriber` object. A nil Entitlements map means none.
type Subscriber struct {
	OriginalAppUserID string
	Entitlements      map[string]Entitlement
}

// Entitlement is one slot of `subscriber.entitlements`. A nil or zero
// ExpiresDate never expires (a lifetime purchase).
type Entitlement struct {
	ExpiresDate       *time.Time
	PurchaseDate      *time.Time
	ProductIdentifier *string
	PeriodType        *string
}

// How a RevenueCat call failed. ErrSubscriberNotFound comes with an empty,
// non-nil Customer: RevenueCat creates subscribers lazily, so an unknown one
// has no entitlements. ErrPermanent (a rejected API key, an unexpected 4xx)
// will not resolve by retrying; ErrRateLimited is carried by a
// *RateLimitError. Anything else is transient.
var (
	ErrSubscriberNotFound = errors.New("rcclient: subscriber not found")
	ErrPermanent          = errors.New("rcclient: permanent failure")
	ErrRateLimited        = errors.New("rcclient: rate limited")
)

// RateLimitError is ErrRateLimited with the Retry-After RevenueCat sent, 0
// when it sent none.
type RateLimitError struct {
	RetryAfter time.Duration
	Status     int
}

func (e *RateLimitError) Error() string {
	if e.RetryAfter > 0 {
		return fmt.Sprintf("rcclient: rate limited (status=%d, retry_after=%s)", e.Status, e.RetryAfter)
	}
	return fmt.Sprintf("rcclient: rate limited (status=%d)", e.Status)
}

func (e *RateLimitError) Unwrap() error { return ErrRateLimited }
