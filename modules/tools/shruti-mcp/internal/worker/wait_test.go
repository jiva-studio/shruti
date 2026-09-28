package worker

import (
	"context"
	"errors"
	"testing"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/runpipeline"
)

// blockingRunner holds each item until its release channel closes, reporting
// when it has started.
type blockingRunner struct {
	started chan struct{}
	release chan struct{}
	done    chan struct{}
}

func (r blockingRunner) Run(_ context.Context, _ string, _ runpipeline.Options) runpipeline.FileSummary {
	close(r.started)
	<-r.release
	close(r.done)
	return runpipeline.FileSummary{}
}

func TestWaitReturnsOnceTheInFlightItemFinishes(t *testing.T) {
	r := blockingRunner{started: make(chan struct{}), release: make(chan struct{}), done: make(chan struct{})}
	p := New(r, 1, 0)
	ctx, stop := context.WithCancel(t.Context())
	p.Start(ctx)
	if err := p.Submit(ctx, Item{Path: "a.mp3"}); err != nil {
		t.Fatal(err)
	}
	<-r.started
	stop()

	waited := make(chan error, 1)
	go func() { waited <- p.Wait(t.Context()) }()
	close(r.release)
	if err := <-waited; err != nil {
		t.Fatalf("Wait: %v", err)
	}
	select {
	case <-r.done:
	default:
		t.Fatal("Wait returned before the in-flight item finished")
	}
}

func TestWaitGivesUpWhenItsContextEnds(t *testing.T) {
	r := blockingRunner{started: make(chan struct{}), release: make(chan struct{}), done: make(chan struct{})}
	p := New(r, 1, 0)
	ctx, stop := context.WithCancel(t.Context())
	defer stop()
	p.Start(ctx)
	if err := p.Submit(ctx, Item{Path: "a.mp3"}); err != nil {
		t.Fatal(err)
	}
	<-r.started
	stop()

	waitCtx, cancelWait := context.WithCancel(t.Context())
	cancelWait()
	if err := p.Wait(waitCtx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Wait with an ended context: %v", err)
	}
	close(r.release)
	if err := p.Wait(t.Context()); err != nil {
		t.Fatalf("Wait after release: %v", err)
	}
}
