package handler

import (
	"testing"

	"github.com/jiva-studio/shruti/auth/internal/domain/account"
	"github.com/jiva-studio/shruti/auth/internal/domain/profile"
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

	mail := &capturingMailer{}
	o := appOptions{
		pool: pool,
		google: fixedIdentity{account.ProviderIdentity{
			Subject: "google-sub", Email: "ada@example.com", EmailVerified: true, Name: "Ada",
		}},
		apple: fixedIdentity{account.ProviderIdentity{Subject: "apple-sub"}},
		policy: profile.ProfilePolicy{
			Email:     profile.FieldPolicy{Enabled: true},
			Name:      profile.FieldPolicy{Enabled: true},
			AvatarURL: profile.FieldPolicy{Enabled: true},
		},
	}
	if withMail {
		o.mailer = mail
	}
	return contractEnv{router: NewRouter(newTestApp(t, o).deps()), mail: mail}
}
