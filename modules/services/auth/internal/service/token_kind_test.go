package service

import (
	"errors"
	"testing"

	"github.com/jiva-studio/shruti/auth/internal/providers"
)

// TestAnonymousIgnoresRevokedRefreshBearer: a signed-out user's refresh
// token keeps a valid signature for 90 days. Presented as the Bearer of
// /auth/anonymous it must not mint a fresh session for that user; the
// device lands on its own anonymous user instead.
func TestAnonymousIgnoresRevokedRefreshBearer(t *testing.T) {
	svc, stub := boot(t)
	ctx := t.Context()

	stub.Want = providers.Identity{Subject: "g-revoked", Email: "revoked@example.com", EmailVerified: true}
	signedIn, err := svc.SigninGoogle(ctx, SocialInput{IDToken: "stub", DeviceID: "dev-R"})
	if err != nil {
		t.Fatalf("signin: %v", err)
	}
	if err := svc.Signout(ctx, signedIn.RefreshToken); err != nil {
		t.Fatalf("signout: %v", err)
	}

	got, err := svc.Anonymous(ctx, "dev-attacker", signedIn.RefreshToken)
	if err != nil {
		t.Fatalf("anonymous: %v", err)
	}
	if got.UserID == signedIn.UserID {
		t.Fatal("revoked refresh token as Bearer minted a session for the signed-out user")
	}
	if !got.Anonymous {
		t.Error("device without a valid access Bearer must get an anonymous session")
	}
}

// TestSigninDoesNotUpgradeViaRefreshBearer: the anonymous-upgrade branch
// of social sign-in reads the Bearer as an access token only. An anon
// user's refresh token in that header does not attach the new identity to
// the anon user.
func TestSigninDoesNotUpgradeViaRefreshBearer(t *testing.T) {
	svc, stub := boot(t)
	ctx := t.Context()

	anon, err := svc.Anonymous(ctx, "dev-anon-refresh", "")
	if err != nil {
		t.Fatalf("anon: %v", err)
	}
	stub.Want = providers.Identity{Subject: "g-upgrade-refresh", Email: "up@example.com", EmailVerified: true}
	signedIn, err := svc.SigninGoogle(ctx, SocialInput{IDToken: "stub", BearerAccess: anon.RefreshToken})
	if err != nil {
		t.Fatalf("signin: %v", err)
	}
	if signedIn.UserID == anon.UserID {
		t.Fatal("refresh token as Bearer upgraded the anonymous user")
	}
}

// TestRefreshRejectsAccessToken: an access token is not a refresh token.
func TestRefreshRejectsAccessToken(t *testing.T) {
	svc, _ := boot(t)
	ctx := t.Context()

	sess, err := svc.Anonymous(ctx, "dev-access-as-refresh", "")
	if err != nil {
		t.Fatalf("anon: %v", err)
	}
	if _, err := svc.Refresh(ctx, sess.AccessToken); !errors.Is(err, ErrRefreshRejected) {
		t.Fatalf("access token on Refresh: got %v, want ErrRefreshRejected", err)
	}
	if _, err := svc.Refresh(ctx, sess.RefreshToken); err != nil {
		t.Fatalf("refresh with refresh token: %v", err)
	}
}
