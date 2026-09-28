package application_test

import (
	"sync"
	"testing"

	"github.com/google/uuid"

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
