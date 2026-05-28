package httpx

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/jiva-studio/shruti-share-audio/internal/logx"
)

// Dispatcher coalesces background work by key. The first call for a key
// kicks off a goroutine; concurrent calls for the same key while the
// worker is in flight are dropped — this is what stops N parallel POSTs
// for the same excerpt id from running N parallel cuts. Once the worker
// finishes (success or failure), the key is released so a later request
// can re-trigger it (e.g. if the previous run failed before upload).
//
// The worker receives a fresh context.Background() scoped by Timeout,
// not the HTTP request context. That's the whole point of this type:
// keep the cut going after the client disconnects.
type Dispatcher struct {
	mu       sync.Mutex
	inflight map[string]struct{}
	timeout  time.Duration
	log      *slog.Logger
}

func NewDispatcher(timeout time.Duration, log *slog.Logger) *Dispatcher {
	return &Dispatcher{
		inflight: make(map[string]struct{}),
		timeout:  timeout,
		log:      log,
	}
}

// Dispatch returns true when it actually scheduled the work (i.e. no
// other goroutine is processing the same key). Returns false on a
// coalesced/dropped call. The caller doesn't need the boolean — both
// branches translate to the same HTTP response — but it's useful in
// tests and in dispatcher_test.go.
func (d *Dispatcher) Dispatch(key string, work func(ctx context.Context)) bool {
	d.mu.Lock()
	if _, exists := d.inflight[key]; exists {
		d.mu.Unlock()
		return false
	}
	d.inflight[key] = struct{}{}
	d.mu.Unlock()

	go func() {
		defer func() {
			d.mu.Lock()
			delete(d.inflight, key)
			d.mu.Unlock()
		}()
		ctx := logx.Into(context.Background(), d.log.With("dispatch_key", key))
		ctx, cancel := context.WithTimeout(ctx, d.timeout)
		defer cancel()
		work(ctx)
	}()
	return true
}
