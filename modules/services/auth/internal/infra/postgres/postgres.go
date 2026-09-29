// Package postgres stores the auth schema in Postgres.
//
// Migrations are not owned by this service — the central `migrator` compose
// container applies all SQL across services. Auth's boot sequence only opens
// a pool and asserts the expected tables are present. Every query qualifies
// its objects with `auth.<table>`, so any search_path works.
package postgres

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti/auth/internal/ports"
)

// Connect opens a pool and pings it.
func Connect(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, err
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}

	ctx2, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(ctx2); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return pool, nil
}

// AssertSchemaReady fails loudly if the central migrator hasn't applied
// the auth schema yet, instead of letting every query fail on its own. It
// probes information_schema, so an empty database passes.
func AssertSchemaReady(ctx context.Context, pool *pgxpool.Pool) error {
	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	const q = `SELECT EXISTS (
		SELECT 1 FROM information_schema.tables
		WHERE table_schema = 'auth' AND table_name = 'users'
	)`
	var exists bool
	if err := pool.QueryRow(probeCtx, q).Scan(&exists); err != nil {
		return fmt.Errorf("schema probe failed: %w", err)
	}
	if !exists {
		return fmt.Errorf("schema not migrated: auth.users missing — run `docker compose logs migrator`")
	}
	return nil
}

// querier is what the pool and a transaction have in common.
type querier interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// Store is every auth collection over one querier: the pool, or the
// transaction of a unit of work.
type Store struct{ q querier }

// NewStore binds the collections to the pool.
func NewStore(pool *pgxpool.Pool) *Store { return &Store{q: pool} }

func (s *Store) Users() ports.Users                           { return users{s.q} }
func (s *Store) Identities() ports.Identities                 { return identities{s.q} }
func (s *Store) RefreshTokens() ports.RefreshTokens           { return refreshTokens{s.q} }
func (s *Store) WebhookEvents() ports.WebhookEvents           { return webhookEvents{s.q} }
func (s *Store) EmailCodes() ports.EmailCodes                 { return emailCodes{s.q} }
func (s *Store) SubscriptionGrants() ports.SubscriptionGrants { return subscriptionGrants{s.q} }
func (s *Store) Outbox() ports.Outbox                         { return outbox{s.q} }

// LockSubscriber takes a transaction-scoped advisory lock keyed on the
// customer id, namespaced by a constant tag; it is released on commit or
// rollback and blocks no other customer.
func (s *Store) LockSubscriber(ctx context.Context, appUserID string) error {
	_, err := s.q.Exec(ctx,
		`SELECT pg_advisory_xact_lock(hashtext('rc-subscription'), hashtext($1))`,
		appUserID,
	)
	return err
}

// UnitOfWork runs work in one pgx transaction.
type UnitOfWork struct{ pool *pgxpool.Pool }

// NewUnitOfWork opens its transactions on pool.
func NewUnitOfWork(pool *pgxpool.Pool) *UnitOfWork { return &UnitOfWork{pool: pool} }

func (u *UnitOfWork) Do(ctx context.Context, fn func(tx ports.Store) error) error {
	return pgx.BeginFunc(ctx, u.pool, func(tx pgx.Tx) error {
		return fn(&Store{q: tx})
	})
}
