// Package integration runs profile's use cases against its real Postgres
// adapter. Without TEST_DATABASE_URL every test here fails when CI is set and
// skips otherwise.
package integration

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	cursorcase "github.com/jiva-studio/shruti/profile/internal/application/cursor"
	"github.com/jiva-studio/shruti/profile/internal/application/library"
	pullcase "github.com/jiva-studio/shruti/profile/internal/application/pull"
	"github.com/jiva-studio/shruti/profile/internal/application/purge"
	pushcase "github.com/jiva-studio/shruti/profile/internal/application/push"
	"github.com/jiva-studio/shruti/profile/internal/domain/changes"
	"github.com/jiva-studio/shruti/profile/internal/infra/postgres"
	"github.com/jiva-studio/shruti/profile/internal/ports"
)

// Service is every sync use case bound to one store, with the pool behind it
// for the tests' own queries.
type Service struct {
	Pool    *pgxpool.Pool
	Changes masterReader

	push    *pushcase.UseCase
	pull    *pullcase.UseCase
	cursor  *cursorcase.UseCase
	purge   *purge.UseCase
	library *library.UseCase
}

func serviceOn(pool *pgxpool.Pool, pullMax int) *Service {
	if pullMax <= 0 {
		pullMax = 500
	}
	st := postgres.NewStore(pool)
	s := &Service{Pool: pool, Changes: masterReader{st: st}}
	var err error
	if s.push, err = pushcase.New(st); err != nil {
		panic(err)
	}
	if s.pull, err = pullcase.New(st, pullMax); err != nil {
		panic(err)
	}
	if s.cursor, err = cursorcase.New(st); err != nil {
		panic(err)
	}
	if s.purge, err = purge.New(st); err != nil {
		panic(err)
	}
	if s.library, err = library.New(st); err != nil {
		panic(err)
	}
	return s
}

func (s *Service) Push(ctx context.Context, userID uuid.UUID, req pushcase.Request) (pushcase.Result, error) {
	return s.push.Push(ctx, userID, req)
}

func (s *Service) Pull(ctx context.Context, userID uuid.UUID, req pullcase.Request) (pullcase.Result, error) {
	return s.pull.Pull(ctx, userID, req)
}

func (s *Service) AckCursor(ctx context.Context, userID uuid.UUID, req cursorcase.Request) error {
	return s.cursor.Ack(ctx, userID, req)
}

func (s *Service) Purge(ctx context.Context, userID uuid.UUID) error {
	return s.purge.Purge(ctx, userID)
}

func (s *Service) ApplyLibraryLifecycle(ctx context.Context, userID uuid.UUID, docID, op string, generation, rank int, data json.RawMessage) (changes.Change, error) {
	return s.library.ApplyLibraryLifecycle(ctx, userID, docID, op, generation, rank, data)
}

func (s *Service) MarkPublished(ctx context.Context, userID uuid.UUID, trackID string) error {
	return s.library.MarkPublished(ctx, userID, trackID)
}

// masterReader reads a document's master the way a write sees it.
type masterReader struct{ st *postgres.Store }

func (m masterReader) Latest(ctx context.Context, userID uuid.UUID, collection, docID string) (changes.Change, bool, error) {
	var (
		master changes.Change
		found  bool
	)
	err := m.st.WithinTx(ctx, func(tx ports.Tx) error {
		var err error
		master, found, err = tx.Latest(ctx, userID, collection, docID)
		return err
	})
	return master, found, err
}
