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

type fakeLibraryPurger struct {
	called    int
	gotUserID string
	err       error
}

func (f *fakeLibraryPurger) PurgeLibrary(_ context.Context, userID string) error {
	f.called++
	f.gotUserID = userID
	return f.err
}

// A deleted account used to keep its uploads indexed in chat: the Langfuse
// traces went, the synced profile went, and the transcripts of the lectures
// it had added stayed searchable. Three such accounts and 27 chunks of theirs
// were still in the corpus when this test was written.
func TestUserDeleted_PurgesTheChatLibraryToo(t *testing.T) {
	fp, pp, cp := &fakePurger{}, &fakeProfilePurger{}, &fakeLibraryPurger{}
	h := UserDeleted(fp, pp, cp)
	const uid = "11111111-2222-3333-4444-555555555555"
	if err := h(t.Context(), Event{ID: 1, EventType: "user.deleted", AggregateID: uid}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cp.called != 1 || cp.gotUserID != uid {
		t.Fatalf("chat purge: called=%d id=%q", cp.called, cp.gotUserID)
	}
}

// The outbox must retry, not swallow: a chat that is down leaves the library
// indexed, and the row has to come back.
func TestUserDeleted_ChatFailureIsReturned(t *testing.T) {
	cp := &fakeLibraryPurger{err: errors.New("chat down")}
	h := UserDeleted(&fakePurger{}, &fakeProfilePurger{}, cp)
	if err := h(t.Context(), Event{ID: 1, AggregateID: "u-1"}); err == nil {
		t.Fatal("expected the failure to surface so the outbox retries")
	}
}

// Deployment order: a worker running before chat exposes the endpoint has a
// nil purger and must still finish the other two steps.
func TestUserDeleted_WithoutAChatPurger(t *testing.T) {
	fp, pp := &fakePurger{}, &fakeProfilePurger{}
	if err := UserDeleted(fp, pp, nil)(t.Context(), Event{ID: 1, AggregateID: "u-1"}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fp.called != 1 || pp.called != 1 {
		t.Fatalf("earlier steps skipped: langfuse=%d profile=%d", fp.called, pp.called)
	}
}

func TestUserDeleted_PurgesLangfuseAndProfile(t *testing.T) {
	fp := &fakePurger{}
	pp := &fakeProfilePurger{}
	h := UserDeleted(fp, pp, &fakeLibraryPurger{})
	err := h(t.Context(), Event{
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
	h := UserDeleted(fp, pp, &fakeLibraryPurger{})
	err := h(t.Context(), Event{AggregateID: "abc"})
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
	h := UserDeleted(fp, pp, &fakeLibraryPurger{})
	err := h(t.Context(), Event{AggregateID: "abc"})
	if err == nil {
		t.Fatal("expected error from profile purger to propagate so the outbox retries")
	}
	// Langfuse still ran (idempotent, safe to repeat on the retry).
	if fp.called != 1 {
		t.Errorf("expected langfuse purger to have run, called %d", fp.called)
	}
}
