package application_test

import (
	"errors"
	"testing"
	"time"

	"github.com/jiva-studio/shruti/auth/internal/application/session"
	"github.com/jiva-studio/shruti/auth/internal/application/signin"
	"github.com/jiva-studio/shruti/auth/internal/domain/account"
	"github.com/jiva-studio/shruti/auth/internal/domain/identityhash"
)

// Given a signed-in (non-anonymous) user's access token
// When a brand-new provider identity with no matching verified email signs in
// carrying that token
// Then it lands on a fresh account: only an anonymous bearer is upgraded.
func TestSigninWithSignedInBearerDoesNotCaptureNewIdentity(t *testing.T) {
	svc, stub := boot(t)
	ctx := t.Context()

	anon, err := svc.Anonymous(ctx, "dev-guard", "")
	if err != nil {
		t.Fatalf("anon: %v", err)
	}
	stub.Want = account.ProviderIdentity{Subject: "google-owner"}
	owner, err := svc.SigninGoogle(ctx, signin.Input{IDToken: "stub", BearerAccess: anon.AccessToken})
	if err != nil {
		t.Fatalf("owner signin: %v", err)
	}
	if owner.Anonymous {
		t.Fatal("owner session must be signed in")
	}

	stub.Want = account.ProviderIdentity{Subject: "apple-stranger"}
	other, err := svc.SigninApple(ctx, signin.Input{IDToken: "stub", BearerAccess: owner.AccessToken})
	if err != nil {
		t.Fatalf("second signin: %v", err)
	}
	if other.UserID == owner.UserID {
		t.Fatalf("a signed-in bearer captured a new identity: both on %s", owner.UserID)
	}
}

// Given a refresh row whose stored expiry has passed while its token still
// verifies (the service clock runs ahead of the token's own exp check)
// When it is presented
// Then the refresh is rejected, not rotated.
func TestRefreshRejectsRowPastItsStoredExpiry(t *testing.T) {
	svc, _ := boot(t)
	ctx := t.Context()

	first, err := svc.Anonymous(ctx, "dev-expiry", "")
	if err != nil {
		t.Fatalf("anon: %v", err)
	}
	later := &session.Service{
		Store:       svc.store,
		UnitOfWork:  svc.uow,
		Signer:      svc.Signer,
		Verifier:    svc.Verifier,
		Policy:      svc.ProfilePolicy,
		QuotaPepper: identityhash.LegacyDevicePepper,
		Now:         func() time.Time { return time.Now().Add(session.RefreshTTL + time.Hour) },
	}
	_, err = later.Refresh(ctx, first.RefreshToken)
	if !errors.Is(err, session.ErrRefreshRejected) {
		t.Fatalf("refresh of an expired row: err = %v, want ErrRefreshRejected", err)
	}
}
