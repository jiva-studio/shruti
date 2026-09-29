// Package cursor records how far a device has applied a user's change log.
package cursor

import (
	"context"
	"errors"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/profile/internal/domain/changes"
	"github.com/jiva-studio/shruti/profile/internal/ports"
)

// Request acknowledges the highest global_seq a device has applied.
type Request struct {
	DeviceID string
	AckedSeq int64
}

// UseCase records acknowledgements.
type UseCase struct {
	cursors ports.Cursors
}

// New builds the cursor use case.
func New(cursors ports.Cursors) (*UseCase, error) {
	if cursors == nil {
		return nil, errors.New("cursor: nil cursor store")
	}
	return &UseCase{cursors: cursors}, nil
}

// Ack records the device's acknowledgement; an older one never rewinds it.
func (u *UseCase) Ack(ctx context.Context, userID uuid.UUID, req Request) error {
	if req.DeviceID == "" {
		return changes.BadRequest("device_id is required")
	}
	return u.cursors.Ack(ctx, userID, req.DeviceID, req.AckedSeq)
}
