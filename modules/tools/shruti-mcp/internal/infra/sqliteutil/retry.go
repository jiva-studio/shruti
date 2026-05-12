// Package sqliteutil hosts cross-cutting helpers around go-sqlite3 that
// don't belong to a single store package. Today it carries the SQLITE_BUSY
// retry wrapper used by every lake-registry / catalog write under the
// 4-worker pool.
package sqliteutil

import (
	"context"
	"errors"
	"math/rand"
	"strings"
	"time"

	"github.com/mattn/go-sqlite3"
)

// RetryOptions controls the exponential-backoff retry policy. Zero-value
// is a sensible default (5 attempts, 100ms initial → 1.6s cap, ±20% jitter).
type RetryOptions struct {
	MaxAttempts int           // <=0 → 5
	InitialWait time.Duration // <=0 → 100ms
	MaxWait     time.Duration // <=0 → 5s
	JitterPct   float64       // <0 → 0; clamped to [0, 1)
}

// DefaultRetry is what callers reach for when they don't have a reason
// to tune the policy. Allocated once so the closure WithRetry takes
// doesn't allocate per call.
var DefaultRetry = RetryOptions{}

// WithRetry runs fn under exponential-backoff retry on SQLITE_BUSY /
// "database is locked". Retries are abandoned on:
//   - context cancellation: returns ctx.Err() immediately, fn's last err
//     is dropped (the caller's ctx already failed, no surface to report).
//   - permanent errors (anything other than busy/locked): returned as-is.
//   - exhausted attempts: returns the last seen error wrapped.
//
// fn must be idempotent — every retry starts from scratch. Wrap atomic
// transactions, not arbitrary multi-step sequences. For a SetStage call,
// that means wrapping the whole BeginTx → mutate → Commit cycle.
func WithRetry(ctx context.Context, opts RetryOptions, fn func() error) error {
	if opts.MaxAttempts <= 0 {
		opts.MaxAttempts = 5
	}
	if opts.InitialWait <= 0 {
		opts.InitialWait = 100 * time.Millisecond
	}
	if opts.MaxWait <= 0 {
		opts.MaxWait = 5 * time.Second
	}
	if opts.JitterPct < 0 {
		opts.JitterPct = 0
	}
	if opts.JitterPct >= 1 {
		opts.JitterPct = 0.99
	}

	wait := opts.InitialWait
	var lastErr error
	for attempt := 1; attempt <= opts.MaxAttempts; attempt++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := fn()
		if err == nil {
			return nil
		}
		if !IsBusy(err) {
			return err
		}
		lastErr = err
		if attempt == opts.MaxAttempts {
			break
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(jitter(wait, opts.JitterPct)):
		}
		wait *= 2
		if wait > opts.MaxWait {
			wait = opts.MaxWait
		}
	}
	return lastErr
}

// IsBusy reports whether err is a SQLITE_BUSY / SQLITE_LOCKED retryable
// failure. Catches both the typed go-sqlite3 Error and the textual form
// some wrappers surface ("database is locked").
func IsBusy(err error) bool {
	if err == nil {
		return false
	}
	var se sqlite3.Error
	if errors.As(err, &se) {
		switch se.Code {
		case sqlite3.ErrBusy, sqlite3.ErrLocked:
			return true
		}
	}
	msg := err.Error()
	if strings.Contains(msg, "database is locked") {
		return true
	}
	if strings.Contains(msg, "database table is locked") {
		return true
	}
	return false
}

// jitter returns d adjusted by ±pct (e.g. pct=0.2 yields a value in
// [0.8d, 1.2d]). Used to avoid thundering-herd retry alignment under
// the 4-worker pool.
func jitter(d time.Duration, pct float64) time.Duration {
	if pct == 0 {
		return d
	}
	delta := float64(d) * pct
	// rand.Float64() in [0,1) → swing in [-delta, delta).
	swing := (rand.Float64()*2 - 1) * delta
	out := time.Duration(float64(d) + swing)
	if out < 0 {
		return 0
	}
	return out
}
