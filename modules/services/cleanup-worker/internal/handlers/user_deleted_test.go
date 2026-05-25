package handlers

import (
	"context"
	"errors"
	"testing"
)

type fakePurger struct {
	called    int
	gotUserID string
	err       error
}

func (f *fakePurger) PurgeUserTraces(_ context.Context, userID string) error {
	f.called++
	f.gotUserID = userID
	return f.err
}

func TestUserDeleted_PassesAggregateIDAsUserID(t *testing.T) {
	fp := &fakePurger{}
	h := UserDeleted(fp)
	err := h(context.Background(), Event{
		ID:          1,
		EventType:   "user.deleted",
		AggregateID: "11111111-2222-3333-4444-555555555555",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fp.called != 1 {
		t.Fatalf("expected purger called once, got %d", fp.called)
	}
	if fp.gotUserID != "11111111-2222-3333-4444-555555555555" {
		t.Errorf("user id mismatch: got %q", fp.gotUserID)
	}
}

func TestUserDeleted_PropagatesPurgerError(t *testing.T) {
	fp := &fakePurger{err: errors.New("langfuse 500")}
	h := UserDeleted(fp)
	err := h(context.Background(), Event{AggregateID: "abc"})
	if err == nil {
		t.Fatal("expected error from purger to propagate")
	}
}
