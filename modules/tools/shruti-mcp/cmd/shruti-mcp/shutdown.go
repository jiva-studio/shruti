package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"time"
)

// shutdownGrace bounds each shutdown phase: in-flight MCP requests, then the
// workers leaving the stage they are in. Each phase gets its own budget, so a
// client holding an SSE stream open cannot use up the workers' time.
const shutdownGrace = 30 * time.Second

// shutdown stops the server in dependency order: the MCP transports first
// (closing SSE sessions so their handlers return), then the HTTP server, then
// the worker pool, and only once no worker is inside a stage, the stores.
type shutdown struct {
	transports []func(context.Context) error
	http       func(context.Context) error
	stopPool   func()
	waitPool   func(context.Context) error
	close      func() error
	httpGrace  time.Duration
	poolGrace  time.Duration
}

func (s shutdown) run(parent context.Context) error {
	base := context.WithoutCancel(parent)

	httpCtx, cancelHTTP := context.WithTimeout(base, s.httpGrace)
	var err error
	for _, stop := range s.transports {
		if serr := stop(httpCtx); serr != nil {
			err = errors.Join(err, fmt.Errorf("mcp transport shutdown: %w", serr))
		}
	}
	if serr := s.http(httpCtx); serr != nil {
		err = errors.Join(err, fmt.Errorf("http shutdown: %w", serr))
	}
	cancelHTTP()

	s.stopPool()
	poolCtx, cancelPool := context.WithTimeout(base, s.poolGrace)
	defer cancelPool()
	if werr := s.waitPool(poolCtx); werr != nil {
		// A worker still inside a stage would write to a closed database.
		// The process is exiting; SQLite recovers an unclosed WAL on open.
		log.Printf("shutdown: stores left open, a worker is still running")
		return errors.Join(err, werr)
	}
	return errors.Join(err, s.close())
}
