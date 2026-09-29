package rcsync_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/auth/internal/application/rcsync"
	"github.com/jiva-studio/shruti/auth/internal/domain/account"
	"github.com/jiva-studio/shruti/auth/internal/domain/subscription"
	"github.com/jiva-studio/shruti/auth/internal/ports"
)

// fakeDB is one customer's state behind a unit of work whose LockSubscriber
// holds a per-customer mutex until the unit of work ends, as the advisory
// transaction lock does.
type fakeDB struct {
	userID uuid.UUID

	mu          sync.Mutex
	locks       map[string]*sync.Mutex
	processed   map[string]bool
	upserts     int
	inUpsert    int
	maxInUpsert int
	outbox      map[string]int
}

func newFakeDB() *fakeDB {
	return &fakeDB{
		userID:    uuid.New(),
		locks:     map[string]*sync.Mutex{},
		processed: map[string]bool{},
		outbox:    map[string]int{},
	}
}

type fakeUoW struct{ db *fakeDB }

func (u fakeUoW) Do(_ context.Context, fn func(tx ports.Store) error) error {
	tx := &fakeTx{db: u.db}
	defer func() {
		for _, l := range tx.held {
			l.Unlock()
		}
	}()
	return fn(tx)
}

type fakeTx struct {
	ports.Store
	db   *fakeDB
	held []*sync.Mutex
}

func (t *fakeTx) LockSubscriber(_ context.Context, appUserID string) error {
	t.db.mu.Lock()
	l, ok := t.db.locks[appUserID]
	if !ok {
		l = &sync.Mutex{}
		t.db.locks[appUserID] = l
	}
	t.db.mu.Unlock()
	l.Lock()
	t.held = append(t.held, l)
	return nil
}

func (t *fakeTx) Users() ports.Users                 { return fakeUsers{db: t.db} }
func (t *fakeTx) WebhookEvents() ports.WebhookEvents { return fakeEvents{db: t.db} }
func (t *fakeTx) Outbox() ports.Outbox               { return fakeOutbox{db: t.db} }

type fakeUsers struct {
	ports.Users
	db *fakeDB
}

func (u fakeUsers) IDByRCAppUserID(context.Context, string) (uuid.UUID, bool, error) {
	return u.db.userID, true, nil
}

// UpsertSubscriptionState lingers so that calls not serialised by the lock
// overlap and every one of them gets past the processed re-check.
func (u fakeUsers) UpsertSubscriptionState(context.Context, subscription.Snapshot) (uuid.UUID, subscription.UpsertOutcome, error) {
	u.db.mu.Lock()
	u.db.upserts++
	u.db.inUpsert++
	u.db.maxInUpsert = max(u.db.maxInUpsert, u.db.inUpsert)
	u.db.mu.Unlock()
	time.Sleep(5 * time.Millisecond)
	u.db.mu.Lock()
	u.db.inUpsert--
	u.db.mu.Unlock()
	return u.db.userID, subscription.UpsertApplied, nil
}

type fakeEvents struct {
	ports.WebhookEvents
	db *fakeDB
}

func (e fakeEvents) LookupProcessed(_ context.Context, eventID string) (bool, error) {
	e.db.mu.Lock()
	defer e.db.mu.Unlock()
	return e.db.processed[eventID], nil
}

func (e fakeEvents) MarkProcessed(_ context.Context, eventID string) error {
	e.db.mu.Lock()
	defer e.db.mu.Unlock()
	e.db.processed[eventID] = true
	return nil
}

func (e fakeEvents) RecordError(context.Context, string, string) error { return nil }

type fakeOutbox struct {
	ports.Outbox
	db *fakeDB
}

func (o fakeOutbox) EmitSubscriptionChanged(_ context.Context, _ uuid.UUID, _ []byte, sourceEventID string) error {
	o.db.mu.Lock()
	defer o.db.mu.Unlock()
	o.db.outbox[sourceEventID]++
	return nil
}

// Retries of one webhook applied at once for the same customer serialise on
// the customer lock: the first writes the snapshot, the rest find the event
// processed and write nothing.
func TestConcurrentApplyForOneCustomerWritesOnce(t *testing.T) {
	db := newFakeDB()
	svc := &rcsync.Service{UnitOfWork: fakeUoW{db: db}}
	exp := time.Now().Add(30 * 24 * time.Hour)
	snap := subscription.Snapshot{AppUserID: "rc-1", Tier: account.TierPro, TierExpiresAt: &exp, SnapshotAt: time.Now()}

	const retries = 8
	var wg sync.WaitGroup
	errs := make(chan error, retries)
	for range retries {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id, matched, err := svc.Apply(t.Context(), "ev-1", snap)
			if err == nil && (!matched || id != db.userID) {
				t.Errorf("apply = (%s, %v), want (%s, true)", id, matched, db.userID)
			}
			errs <- err
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if db.maxInUpsert > 1 {
		t.Errorf("%d applies wrote the customer at once", db.maxInUpsert)
	}
	if db.upserts != 1 {
		t.Errorf("snapshot written %d times, want once", db.upserts)
	}
	if db.outbox["ev-1"] != 1 {
		t.Errorf("subscription.changed emitted %d times, want once", db.outbox["ev-1"])
	}
}

// Different events for one customer each apply, one at a time.
func TestConcurrentApplyOfDistinctEventsSerialises(t *testing.T) {
	db := newFakeDB()
	svc := &rcsync.Service{UnitOfWork: fakeUoW{db: db}}
	snap := subscription.Snapshot{AppUserID: "rc-1", Tier: account.TierPro, SnapshotAt: time.Now()}

	events := []string{"ev-a", "ev-b", "ev-c", "ev-d"}
	var wg sync.WaitGroup
	for _, ev := range events {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, _, err := svc.Apply(t.Context(), ev, snap); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if db.maxInUpsert > 1 {
		t.Errorf("%d applies wrote the customer at once", db.maxInUpsert)
	}
	if db.upserts != len(events) {
		t.Errorf("snapshot written %d times, want %d", db.upserts, len(events))
	}
	for _, ev := range events {
		if !db.processed[ev] || db.outbox[ev] != 1 {
			t.Errorf("%s: processed=%v outbox=%d", ev, db.processed[ev], db.outbox[ev])
		}
	}
}
