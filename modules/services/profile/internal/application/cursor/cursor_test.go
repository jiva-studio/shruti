package cursor_test

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/jiva-studio/shruti/profile/internal/application/cursor"
	"github.com/jiva-studio/shruti/profile/internal/domain/changes"
)

type ack struct {
	user   uuid.UUID
	device string
	seq    int64
}

type cursors struct {
	acks []ack
	err  error
}

func (c *cursors) Ack(_ context.Context, userID uuid.UUID, deviceID string, ackedSeq int64) error {
	c.acks = append(c.acks, ack{userID, deviceID, ackedSeq})
	return c.err
}

func TestNewRefusesANilStore(t *testing.T) {
	if _, err := cursor.New(nil); err == nil {
		t.Fatal("cursor.New(nil) succeeded")
	}
}

func TestAckRecordsTheDeviceCursor(t *testing.T) {
	c := &cursors{}
	uc, err := cursor.New(c)
	if err != nil {
		t.Fatal(err)
	}
	user := uuid.New()
	if err := uc.Ack(t.Context(), user, cursor.Request{DeviceID: "dev-1", AckedSeq: 42}); err != nil {
		t.Fatal(err)
	}
	if len(c.acks) != 1 || c.acks[0] != (ack{user, "dev-1", 42}) {
		t.Fatalf("acks = %+v", c.acks)
	}
}

func TestAckWithoutADeviceIsRefused(t *testing.T) {
	c := &cursors{}
	uc, err := cursor.New(c)
	if err != nil {
		t.Fatal(err)
	}
	if err := uc.Ack(t.Context(), uuid.New(), cursor.Request{AckedSeq: 1}); !changes.IsValidation(err) {
		t.Fatalf("err = %v, want a validation error", err)
	}
	if len(c.acks) != 0 {
		t.Fatal("a refused ack reached the store")
	}
}

func TestAckPassesAStoreErrorOn(t *testing.T) {
	c := &cursors{err: errors.New("db down")}
	uc, err := cursor.New(c)
	if err != nil {
		t.Fatal(err)
	}
	if err := uc.Ack(t.Context(), uuid.New(), cursor.Request{DeviceID: "d"}); !errors.Is(err, c.err) {
		t.Fatalf("err = %v", err)
	}
}
