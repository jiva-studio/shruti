// Package purge erases a deleted user from profile's database.
package purge

import (
	"context"
	"errors"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/profile/internal/ports"
)

// UseCase purges users.
type UseCase struct {
	tx ports.Transactor
}

// New builds the purge use case.
func New(tx ports.Transactor) (*UseCase, error) {
	if tx == nil {
		return nil, errors.New("purge: nil transactor")
	}
	return &UseCase{tx: tx}, nil
}

// Purge deletes every row the user has, in every profile table, in one
// transaction. A retried purge is a no-op.
func (u *UseCase) Purge(ctx context.Context, userID uuid.UUID) error {
	return u.tx.WithinTx(ctx, func(tx ports.Tx) error {
		return tx.PurgeUser(ctx, userID)
	})
}
