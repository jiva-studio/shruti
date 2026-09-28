package main

import (
	"bufio"
	"context"
	"errors"
	"net"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/mcp/tools"
)

// The transports stop before the HTTP server, the pool is stopped and drained
// after it, and the stores close last.
func TestShutdownStopsInDependencyOrder(t *testing.T) {
	var order []string
	step := func(name string) func(context.Context) error {
		return func(context.Context) error { order = append(order, name); return nil }
	}
	err := shutdown{
		transports: []func(context.Context) error{step("sse"), step("streamable")},
		http:       step("http"),
		stopPool:   func() { order = append(order, "stop-pool") },
		waitPool:   step("wait-pool"),
		close:      func() error { order = append(order, "close"); return nil },
		httpGrace:  time.Second,
		poolGrace:  time.Second,
	}.run(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"sse", "streamable", "http", "stop-pool", "wait-pool", "close"}
	if !slices.Equal(order, want) {
		t.Fatalf("order = %v, want %v", order, want)
	}
}

// An HTTP phase that uses up its whole grace leaves the pool its own.
func TestShutdownGivesThePoolItsOwnGrace(t *testing.T) {
	var poolCtxErr error
	closed := false
	err := shutdown{
		http: func(ctx context.Context) error {
			<-ctx.Done()
			return ctx.Err()
		},
		stopPool: func() {},
		waitPool: func(ctx context.Context) error {
			poolCtxErr = ctx.Err()
			return nil
		},
		close:     func() error { closed = true; return nil },
		httpGrace: 10 * time.Millisecond,
		poolGrace: time.Minute,
	}.run(t.Context())
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("http timeout not reported: %v", err)
	}
	if poolCtxErr != nil {
		t.Fatalf("pool drained with a spent context: %v", poolCtxErr)
	}
	if !closed {
		t.Fatal("stores not closed after the pool drained")
	}
}

// A worker still inside a stage when the grace runs out keeps the stores
// open: closing them would fail its writes halfway.
func TestShutdownLeavesStoresOpenWhileAWorkerRuns(t *testing.T) {
	closed := false
	err := shutdown{
		http:     func(context.Context) error { return nil },
		stopPool: func() {},
		waitPool: func(ctx context.Context) error {
			<-ctx.Done()
			return ctx.Err()
		},
		close:     func() error { closed = true; return nil },
		httpGrace: time.Second,
		poolGrace: 10 * time.Millisecond,
	}.run(t.Context())
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("pool timeout not reported: %v", err)
	}
	if closed {
		t.Fatal("stores closed while a worker was still running")
	}
}

// An open SSE stream does not hold shutdown for the whole grace: the SSE
// server closes its session and the HTTP server then drains at once.
func TestShutdownEndsAnOpenSSEStream(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	m := buildMCPHTTPServer(tools.Deps{}, ln.Addr().String(), time.Hour)
	served := make(chan error, 1)
	go func() { served <- m.http.Serve(ln) }()

	req, err := http.NewRequestWithContext(t.Context(), http.MethodGet, "http://"+ln.Addr().String()+ssePath, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	line, err := bufio.NewReader(resp.Body).ReadString('\n')
	if err != nil || !strings.HasPrefix(line, "event: endpoint") {
		t.Fatalf("sse stream not open: %q %v", line, err)
	}

	start := time.Now()
	err = shutdown{
		transports: []func(context.Context) error{m.sse.Shutdown, m.streamable.Shutdown},
		http:       m.http.Shutdown,
		stopPool:   func() {},
		waitPool:   func(context.Context) error { return nil },
		close:      func() error { return nil },
		httpGrace:  5 * time.Second,
		poolGrace:  time.Second,
	}.run(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("shutdown waited %v on an open SSE stream", elapsed)
	}
	if err := <-served; !errors.Is(err, http.ErrServerClosed) {
		t.Fatalf("serve: %v", err)
	}
}
