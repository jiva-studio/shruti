package purge_test

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/profile/internal/application/purge"
	"github.com/jiva-studio/shruti/profile/internal/ports"
)

// transactor records the users purged inside each unit of work and whether
// that unit of work committed.
type transactor struct {
	purgeErr  error
	purged    []uuid.UUID
	committed int
}

func (tr *transactor) WithinTx(_ context.Context, fn func(ports.Tx) error) error {
	if err := fn(purgeTx{tr: tr}); err != nil {
		return err
	}
	tr.committed++
	return nil
}

// purgeTx implements only PurgeUser; any other call panics on the nil
// embedded Tx, so the test fails if the use case reaches for more.
type purgeTx struct {
	ports.Tx
	tr *transactor
}

func (p purgeTx) PurgeUser(_ context.Context, userID uuid.UUID) error {
	p.tr.purged = append(p.tr.purged, userID)
	return p.tr.purgeErr
}

func TestNewRefusesANilTransactor(t *testing.T) {
	if _, err := purge.New(nil); err == nil {
		t.Fatal("purge.New(nil) succeeded")
	}
}

func TestPurgeDeletesTheUserInOneTransaction(t *testing.T) {
	tr := &transactor{}
	uc, err := purge.New(tr)
	if err != nil {
		t.Fatal(err)
	}
	user := uuid.New()
	if err := uc.Purge(t.Context(), user); err != nil {
		t.Fatal(err)
	}
	if len(tr.purged) != 1 || tr.purged[0] != user || tr.committed != 1 {
		t.Fatalf("purged = %v, committed = %d", tr.purged, tr.committed)
	}
}

func TestPurgeThatFailsDoesNotCommit(t *testing.T) {
	tr := &transactor{purgeErr: errors.New("db down")}
	uc, err := purge.New(tr)
	if err != nil {
		t.Fatal(err)
	}
	if err := uc.Purge(t.Context(), uuid.New()); !errors.Is(err, tr.purgeErr) {
		t.Fatalf("err = %v", err)
	}
	if tr.committed != 0 {
		t.Fatal("a failed purge committed")
	}
}
