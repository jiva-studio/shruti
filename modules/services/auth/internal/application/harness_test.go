// Package application_test runs the auth use cases together against a real
// Postgres, wired the way cmd/auth wires them.
package application_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	appaccount "github.com/jiva-studio/shruti/auth/internal/application/account"
	"github.com/jiva-studio/shruti/auth/internal/application/emailotp"
	"github.com/jiva-studio/shruti/auth/internal/application/grant"
	"github.com/jiva-studio/shruti/auth/internal/application/rcsync"
	"github.com/jiva-studio/shruti/auth/internal/application/session"
	"github.com/jiva-studio/shruti/auth/internal/application/signin"
	"github.com/jiva-studio/shruti/auth/internal/domain/profile"
	"github.com/jiva-studio/shruti/auth/internal/domain/subscription"
	"github.com/jiva-studio/shruti/auth/internal/infra/postgres"
	"github.com/jiva-studio/shruti/auth/internal/ports"
	"github.com/jiva-studio/shruti/authjwt"
)

// The email-code caps the tests exercise: attempts per code, and per
// address in a rolling 24h window.
const (
	maxAttemptsPerCode = 5
	maxAttemptsPerDay  = 20
)

// quotaPepper salts anonymous quota ids in tests.
const quotaPepper = "test-pepper"

// emailSubject is the identity subject of the email provider: the hex
// sha256 of the normalized address, never the address itself.
func emailSubject(addr string) string {
	sum := sha256.Sum256([]byte(addr))
	return hex.EncodeToString(sum[:])
}

// Service is the use cases over one database, rebuilt on every call from
// its fields so a test can swap a collaborator (the mailer, RevenueCat, the
// profile policy) after boot.
type Service struct {
	Pool           *pgxpool.Pool
	Users          ports.Users
	Identities     ports.Identities
	EmailOTP       ports.EmailCodes
	Signer         *authjwt.Signer
	Verifier       *authjwt.Verifier
	GoogleVerifier ports.IDTokenVerifier
	AppleVerifier  ports.IDTokenVerifier
	Emailer        ports.Mailer
	ProfilePolicy  profile.ProfilePolicy
	RC             ports.RevenueCat
	RCMetrics      ports.RevenueCatMetrics
	// RCProEntitlement is the entitlement GrantAndApply grants.
	RCProEntitlement string

	store *postgres.Store
	uow   *postgres.UnitOfWork
}

func newService(pool *pgxpool.Pool, signer *authjwt.Signer, verifier *authjwt.Verifier, idp ports.IDTokenVerifier, policy profile.ProfilePolicy) *Service {
	store := postgres.NewStore(pool)
	return &Service{
		Pool:           pool,
		Users:          store.Users(),
		Identities:     store.Identities(),
		EmailOTP:       store.EmailCodes(),
		Signer:         signer,
		Verifier:       verifier,
		GoogleVerifier: idp,
		AppleVerifier:  idp,
		ProfilePolicy:  policy,
		store:          store,
		uow:            postgres.NewUnitOfWork(pool),
	}
}

func (s *Service) sessions() *session.Service {
	return &session.Service{
		Store:       s.store,
		UnitOfWork:  s.uow,
		Signer:      s.Signer,
		Verifier:    s.Verifier,
		Policy:      s.ProfilePolicy,
		QuotaPepper: quotaPepper,
		Now:         time.Now,
	}
}

func (s *Service) signIn() *signin.Service {
	return &signin.Service{
		Store:          s.store,
		UnitOfWork:     s.uow,
		Sessions:       s.sessions(),
		GoogleVerifier: s.GoogleVerifier,
		AppleVerifier:  s.AppleVerifier,
		Policy:         s.ProfilePolicy,
	}
}

func (s *Service) sync() *rcsync.Service {
	return &rcsync.Service{Store: s.store, UnitOfWork: s.uow, RC: s.RC, Metrics: s.RCMetrics, Clock: time.Now}
}

func (s *Service) Anonymous(ctx context.Context, deviceID, bearer string) (*session.Session, error) {
	return s.signIn().Anonymous(ctx, deviceID, bearer)
}

func (s *Service) SigninGoogle(ctx context.Context, in signin.Input) (*session.Session, error) {
	return s.signIn().Google(ctx, in)
}

func (s *Service) SigninApple(ctx context.Context, in signin.Input) (*session.Session, error) {
	return s.signIn().Apple(ctx, in)
}

func (s *Service) Refresh(ctx context.Context, refreshToken string) (*session.Session, error) {
	return s.sessions().Refresh(ctx, refreshToken)
}

func (s *Service) Signout(ctx context.Context, refreshToken string) error {
	return s.sessions().Signout(ctx, refreshToken)
}

func (s *Service) accounts() *appaccount.Service {
	return &appaccount.Service{Store: s.store, UnitOfWork: s.uow, Policy: s.ProfilePolicy, Now: time.Now}
}

func (s *Service) Me(ctx context.Context, userID uuid.UUID) (*profile.Me, error) {
	return s.accounts().Me(ctx, userID)
}

func (s *Service) DeleteAccount(ctx context.Context, userID uuid.UUID) error {
	return s.accounts().Delete(ctx, userID)
}

func (s *Service) emailCodes() *emailotp.Service {
	return &emailotp.Service{Codes: s.EmailOTP, Mailer: s.Emailer, SignIn: s.signIn(), Now: time.Now}
}

func (s *Service) RequestEmailOTP(ctx context.Context, email, locale string) error {
	return s.emailCodes().Request(ctx, email, locale)
}

func (s *Service) VerifyEmailOTP(ctx context.Context, email, code string, in signin.Input) (*session.Session, error) {
	return s.emailCodes().Verify(ctx, email, code, in)
}

func (s *Service) ApplyRCSubscriberState(ctx context.Context, eventID string, snap subscription.Snapshot) (uuid.UUID, bool, error) {
	return s.sync().Apply(ctx, eventID, snap)
}

func (s *Service) HandleDelivery(ctx context.Context, d rcsync.Delivery) rcsync.Outcome {
	return s.sync().HandleDelivery(ctx, d)
}

func (s *Service) GrantAndApply(ctx context.Context, userID uuid.UUID, duration, grantKey string) error {
	g := &grant.Service{
		Store:          s.store,
		RC:             s.RC,
		Sync:           s.sync(),
		ProEntitlement: s.RCProEntitlement,
		Now:            time.Now,
	}
	return g.GrantAndApply(ctx, userID, duration, grantKey)
}
