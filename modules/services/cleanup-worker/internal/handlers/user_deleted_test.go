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

type fakeProfilePurger struct {
	called    int
	gotUserID string
	err       error
}

func (f *fakeProfilePurger) PurgeUser(_ context.Context, userID string) error {
	f.called++
	f.gotUserID = userID
	return f.err
}

func TestUserDeleted_PurgesLangfuseAndProfile(t *testing.T) {
	fp := &fakePurger{}
	pp := &fakeProfilePurger{}
	h := UserDeleted(fp, pp)
	err := h(context.Background(), Event{
		ID:          1,
		EventType:   "user.deleted",
		AggregateID: "11111111-2222-3333-4444-555555555555",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fp.called != 1 {
		t.Fatalf("expected langfuse purger called once, got %d", fp.called)
	}
	if pp.called != 1 {
		t.Fatalf("expected profile purger called once, got %d", pp.called)
	}
	const wantID = "11111111-2222-3333-4444-555555555555"
	if fp.gotUserID != wantID {
		t.Errorf("langfuse user id mismatch: got %q", fp.gotUserID)
	}
	if pp.gotUserID != wantID {
		t.Errorf("profile user id mismatch: got %q", pp.gotUserID)
	}
}

func TestUserDeleted_PropagatesLangfuseError(t *testing.T) {
	fp := &fakePurger{err: errors.New("langfuse 500")}
	pp := &fakeProfilePurger{}
	h := UserDeleted(fp, pp)
	err := h(context.Background(), Event{AggregateID: "abc"})
	if err == nil {
		t.Fatal("expected error from langfuse purger to propagate")
	}
	// Langfuse ran first and failed → profile must not run (chain short-circuits).
	if pp.called != 0 {
		t.Errorf("profile purger should not run after langfuse error, called %d", pp.called)
	}
}

func TestUserDeleted_PropagatesProfileError(t *testing.T) {
	fp := &fakePurger{}
	pp := &fakeProfilePurger{err: errors.New("profile 503")}
	h := UserDeleted(fp, pp)
	err := h(context.Background(), Event{AggregateID: "abc"})
	if err == nil {
		t.Fatal("expected error from profile purger to propagate so the outbox retries")
	}
	// Langfuse still ran (idempotent, safe to repeat on the retry).
	if fp.called != 1 {
		t.Errorf("expected langfuse purger to have run, called %d", fp.called)
	}
}
