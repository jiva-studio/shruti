package postgres

import (
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti/auth/internal/ports"
)

// LockSubscriber holds one customer until the unit of work ends: a second
// unit of work on the same customer waits, one on another customer does not.
func TestLockSubscriberSerialisesOneCustomer(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to run Postgres integration tests")
	}
	ctx := t.Context()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)
	uow := NewUnitOfWork(pool)

	// release lets a held unit of work end once; on a failed assertion the
	// cleanup releases the rest, so pool.Close does not wait on them.
	var releases []func()
	release := func() (<-chan struct{}, func()) {
		ch := make(chan struct{})
		var once sync.Once
		f := func() { once.Do(func() { close(ch) }) }
		releases = append(releases, f)
		return ch, f
	}
	t.Cleanup(func() {
		for _, f := range releases {
			f()
		}
	})

	// lockIn runs a unit of work that takes the customer's lock, reports it
	// held on acquired and keeps it until gate is closed.
	lockIn := func(customer string, acquired chan<- struct{}, gate <-chan struct{}) <-chan error {
		done := make(chan error, 1)
		go func() {
			done <- uow.Do(ctx, func(tx ports.Store) error {
				if err := tx.LockSubscriber(ctx, customer); err != nil {
					return err
				}
				close(acquired)
				<-gate
				return nil
			})
		}()
		return done
	}

	firstHeld := make(chan struct{})
	firstGate, releaseFirst := release()
	firstDone := lockIn("rc-lock-a", firstHeld, firstGate)
	<-firstHeld

	otherHeld := make(chan struct{})
	otherGate, releaseOther := release()
	otherDone := lockIn("rc-lock-b", otherHeld, otherGate)
	select {
	case <-otherHeld:
	case <-time.After(5 * time.Second):
		t.Fatal("a lock on another customer waited")
	}
	releaseOther()

	secondHeld := make(chan struct{})
	secondGate, releaseSecond := release()
	releaseSecond()
	secondDone := lockIn("rc-lock-a", secondHeld, secondGate)
	select {
	case <-secondHeld:
		t.Fatal("a second unit of work took a customer lock that was held")
	case <-time.After(300 * time.Millisecond):
	}

	releaseFirst()
	select {
	case <-secondHeld:
	case <-time.After(5 * time.Second):
		t.Fatal("the lock was not handed on when the first unit of work ended")
	}
	for _, done := range []<-chan error{firstDone, otherDone, secondDone} {
		if err := <-done; err != nil {
			t.Fatal(err)
		}
	}
}
