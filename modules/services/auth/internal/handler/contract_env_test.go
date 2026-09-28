package handler

import (
	"testing"

	"github.com/jiva-studio/shruti/auth/internal/profile"
	"github.com/jiva-studio/shruti/auth/internal/providers"
	"github.com/jiva-studio/shruti/auth/internal/service"
	"github.com/jiva-studio/shruti/auth/internal/store"
	"github.com/jiva-studio/shruti/authjwt"
)

// newContractEnv wires the whole service over a fresh database, with fake
// id-token verifiers and a mailer that keeps what it sends.
func newContractEnv(t *testing.T) contractEnv {
	t.Helper()
	return buildContractEnv(t, true)
}

func newContractEnvWithoutMail(t *testing.T) contractEnv {
	t.Helper()
	return buildContractEnv(t, false)
}

func buildContractEnv(t *testing.T, withMail bool) contractEnv {
	t.Helper()
	pool := resetSchema(t, dbDSNFromEnv(t))
	t.Cleanup(pool.Close)

	priv, pub := tempKeys(t)
	signer, err := authjwt.NewSignerFromFile(priv)
	if err != nil {
		t.Fatalf("signer: %v", err)
	}
	verifier, err := authjwt.NewVerifierFromFile(pub)
	if err != nil {
		t.Fatalf("verifier: %v", err)
	}
	google := fixedIdentity{providers.Identity{
		Subject: "google-sub", Email: "ada@example.com", EmailVerified: true, Name: "Ada",
	}}
	apple := fixedIdentity{providers.Identity{Subject: "apple-sub"}}
	mail := &capturingMailer{}
	svc := &service.Service{
		Pool:           pool,
		Users:          &store.UserRepo{Pool: pool},
		Identities:     &store.IdentityRepo{Pool: pool},
		RefreshTokens:  &store.RefreshTokenRepo{Pool: pool},
		WebhookEvents:  &store.WebhookEventRepo{Pool: pool},
		EmailOTP:       &store.EmailOTPRepo{Pool: pool},
		Signer:         signer,
		Verifier:       verifier,
		GoogleVerifier: google,
		AppleVerifier:  apple,
		ProfilePolicy: profile.ProfilePolicy{
			Email:     profile.FieldPolicy{Enabled: true},
			Name:      profile.FieldPolicy{Enabled: true},
			AvatarURL: profile.FieldPolicy{Enabled: true},
		},
	}
	if withMail {
		svc.Emailer = mail
	}
	return contractEnv{router: NewRouter(svc, verifier), mail: mail}
}
