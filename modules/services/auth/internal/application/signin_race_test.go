package application_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti/auth/internal/application/signin"
	"github.com/jiva-studio/shruti/auth/internal/domain/account"
)

// TestConcurrentFirstSigninResolvesOneUser: several first sign-ins of the
// same new identity race (double tap, retry after a slow response). All
// succeed and land on one user; the loser of the identity insert re-reads
// the winner's row instead of failing.
func TestConcurrentFirstSigninResolvesOneUser(t *testing.T) {
	svc, stub := boot(t)
	ctx := t.Context()
	stub.Want = account.ProviderIdentity{Subject: "g-race", Email: "race@example.com", EmailVerified: true}

	const n = 8
	var wg sync.WaitGroup
	ids := make(chan uuid.UUID, n)
	errs := make(chan error, n)
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			sess, err := svc.SigninGoogle(ctx, signin.Input{IDToken: "stub"})
			if err != nil {
				errs <- err
				return
			}
			ids <- sess.UserID
		}()
	}
	close(start)
	wg.Wait()
	close(ids)
	close(errs)
	for err := range errs {
		t.Errorf("concurrent first sign-in failed: %v", err)
	}
	var first uuid.UUID
	for id := range ids {
		if first == uuid.Nil {
			first = id
		}
		if id != first {
			t.Fatalf("sign-ins landed on different users: %s vs %s", first, id)
		}
	}
	var identities int
	if err := svc.Pool.QueryRow(ctx,
		`SELECT count(*) FROM auth.identities WHERE provider = 'google' AND subject = 'g-race'`,
	).Scan(&identities); err != nil {
		t.Fatalf("count identities: %v", err)
	}
	if identities != 1 {
		t.Fatalf("identities = %d, want 1", identities)
	}
}

// TestSigninHoldsOneConnection: a sign-in runs on the one connection of its
// transaction, so a pool with a single connection still serves a new identity
// (email cross-link lookup, user creation) and its return (identity lookup).
func TestSigninHoldsOneConnection(t *testing.T) {
	base, stub := boot(t)
	cfg := base.Pool.Config()
	cfg.MaxConns = 1
	pool, err := pgxpool.NewWithConfig(t.Context(), cfg)
	if err != nil {
		t.Fatalf("pool: %v", err)
	}
	t.Cleanup(pool.Close)
	svc := newService(pool, base.Signer, base.Verifier, stub, globalPolicy())
	stub.Want = account.ProviderIdentity{Subject: "g-one-conn", Email: "one-conn@example.com", EmailVerified: true}

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	first, err := svc.SigninGoogle(ctx, signin.Input{IDToken: "stub"})
	if err != nil {
		t.Fatalf("first sign-in: %v", err)
	}
	again, err := svc.SigninGoogle(ctx, signin.Input{IDToken: "stub"})
	if err != nil {
		t.Fatalf("returning sign-in: %v", err)
	}
	if again.UserID != first.UserID {
		t.Fatalf("returning sign-in landed on %s, want %s", again.UserID, first.UserID)
	}
}
