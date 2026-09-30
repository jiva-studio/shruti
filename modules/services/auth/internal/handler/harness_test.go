package handler

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti/auth/internal/application/account"
	"github.com/jiva-studio/shruti/auth/internal/application/emailotp"
	"github.com/jiva-studio/shruti/auth/internal/application/rcsync"
	"github.com/jiva-studio/shruti/auth/internal/application/session"
	"github.com/jiva-studio/shruti/auth/internal/application/signin"
	"github.com/jiva-studio/shruti/auth/internal/domain/profile"
	"github.com/jiva-studio/shruti/auth/internal/infra/postgres"
	"github.com/jiva-studio/shruti/auth/internal/ports"
	"github.com/jiva-studio/shruti/authjwt"
)

// appOptions picks what a test wires. A nil pool leaves the stores
// unusable, for tests that are answered before any database access.
type appOptions struct {
	pool     *pgxpool.Pool
	signer   *authjwt.Signer
	verifier *authjwt.Verifier
	google   ports.IDTokenVerifier
	apple    ports.IDTokenVerifier
	mailer   ports.Mailer
	policy   profile.ProfilePolicy
}

// quotaPepper salts anonymous quota ids in tests.
const quotaPepper = "test-pepper"

// nopMetrics drops the RevenueCat counters.
type nopMetrics struct{}

func (nopMetrics) APIAuthFailed()              {}
func (nopMetrics) APIRateLimited()             {}
func (nopMetrics) APIPermanent()               {}
func (nopMetrics) WebhookPermanentUnresolved() {}
func (nopMetrics) WebhookUnmatched()           {}

// testApp is the service wired the way cmd/auth wires it.
type testApp struct {
	Pool     *pgxpool.Pool
	Users    ports.Users
	Signer   *authjwt.Signer
	Verifier *authjwt.Verifier
	Sessions *session.Service
	SignIn   *signin.Service
	EmailOTP *emailotp.Service
	Accounts *account.Service
	Sync     *rcsync.Service
}

func newTestApp(t *testing.T, o appOptions) *testApp {
	t.Helper()
	if o.signer == nil || o.verifier == nil {
		o.signer, o.verifier = newTokenPair(t)
	}
	store := postgres.NewStore(o.pool)
	uow := postgres.NewUnitOfWork(o.pool)
	sessions := &session.Service{
		Store:       store,
		UnitOfWork:  uow,
		Signer:      o.signer,
		Verifier:    o.verifier,
		Policy:      o.policy,
		QuotaPepper: quotaPepper,
		Now:         time.Now,
	}
	signIn := &signin.Service{
		Store:          store,
		UnitOfWork:     uow,
		Sessions:       sessions,
		GoogleVerifier: o.google,
		AppleVerifier:  o.apple,
		Policy:         o.policy,
	}
	return &testApp{
		Pool:     o.pool,
		Users:    store.Users(),
		Signer:   o.signer,
		Verifier: o.verifier,
		Sessions: sessions,
		SignIn:   signIn,
		EmailOTP: &emailotp.Service{Codes: store.EmailCodes(), Mailer: o.mailer, SignIn: signIn, Now: time.Now},
		Accounts: &account.Service{Store: store, UnitOfWork: uow, Policy: o.policy, Now: time.Now},
		Sync:     &rcsync.Service{Store: store, UnitOfWork: uow, Metrics: nopMetrics{}, Clock: time.Now},
	}
}

func (a *testApp) deps() *Deps {
	return &Deps{
		Sessions: a.Sessions,
		SignIn:   a.SignIn,
		EmailOTP: a.EmailOTP,
		Accounts: a.Accounts,
		Verifier: a.Verifier,
	}
}

func (a *testApp) Anonymous(ctx context.Context, deviceID, bearer string) (*session.Session, error) {
	return a.SignIn.Anonymous(ctx, deviceID, bearer)
}

func (a *testApp) Signout(ctx context.Context, refreshToken string) error {
	return a.Sessions.Signout(ctx, refreshToken)
}
