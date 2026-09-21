package sqliteutil

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/mattn/go-sqlite3"
)

func TestIsBusy(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"plain", errors.New("connection refused"), false},
		{"sqlite3 ErrBusy", sqlite3.Error{Code: sqlite3.ErrBusy}, true},
		{"sqlite3 ErrLocked", sqlite3.Error{Code: sqlite3.ErrLocked}, true},
		{"sqlite3 ErrConstraint not retryable", sqlite3.Error{Code: sqlite3.ErrConstraint}, false},
		{"text database is locked", errors.New("database is locked"), true},
		{"text wrapped", errors.New("commit: database is locked (5)"), true},
		{"text database table is locked", errors.New("database table is locked"), true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := IsBusy(c.err); got != c.want {
				t.Errorf("IsBusy(%v) = %v, want %v", c.err, got, c.want)
			}
		})
	}
}

func TestWithRetrySuccessFirstTry(t *testing.T) {
	calls := 0
	err := WithRetry(t.Context(), RetryOptions{}, func() error {
		calls++
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Errorf("calls = %d, want 1", calls)
	}
}

func TestWithRetryNonBusyErrorReturnsImmediately(t *testing.T) {
	calls := 0
	want := errors.New("permanent")
	err := WithRetry(t.Context(), RetryOptions{}, func() error {
		calls++
		return want
	})
	if !errors.Is(err, want) {
		t.Fatalf("err = %v, want %v", err, want)
	}
	if calls != 1 {
		t.Errorf("calls = %d, want 1 (no retry on permanent error)", calls)
	}
}

func TestWithRetrySucceedsAfterBusy(t *testing.T) {
	calls := 0
	err := WithRetry(t.Context(), RetryOptions{
		MaxAttempts: 5,
		InitialWait: 1 * time.Millisecond,
		MaxWait:     2 * time.Millisecond,
	}, func() error {
		calls++
		if calls < 3 {
			return sqlite3.Error{Code: sqlite3.ErrBusy}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if calls != 3 {
		t.Errorf("calls = %d, want 3", calls)
	}
}

func TestWithRetryGivesUpAfterMaxAttempts(t *testing.T) {
	calls := 0
	busy := sqlite3.Error{Code: sqlite3.ErrBusy}
	err := WithRetry(t.Context(), RetryOptions{
		MaxAttempts: 3,
		InitialWait: 1 * time.Millisecond,
		MaxWait:     2 * time.Millisecond,
	}, func() error {
		calls++
		return busy
	})
	if calls != 3 {
		t.Errorf("calls = %d, want 3", calls)
	}
	if !IsBusy(err) {
		t.Errorf("err = %v, want busy after exhaustion", err)
	}
}

func TestWithRetryAbortsOnContextCancel(t *testing.T) {
	calls := 0
	ctx, cancel := context.WithCancel(t.Context())
	go func() {
		time.Sleep(5 * time.Millisecond)
		cancel()
	}()
	err := WithRetry(ctx, RetryOptions{
		MaxAttempts: 100,
		InitialWait: 10 * time.Millisecond,
		MaxWait:     20 * time.Millisecond,
	}, func() error {
		calls++
		return sqlite3.Error{Code: sqlite3.ErrBusy}
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	if calls > 5 {
		t.Errorf("calls = %d, retried too long after cancel", calls)
	}
}
