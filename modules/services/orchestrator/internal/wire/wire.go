// Package wire is the orchestrator's composition root: it assembles the
// concrete runtime dependencies (Postgres pool, embedded-migration apply,
// schema gate, HTTP handler) from a validated Config, keeping
// cmd/orchestrator thin. Centralizing the wiring here — mirroring the assembly
// services/profile keeps in its entrypoint — gives tests and any future
// entrypoint a single seam to construct the service.
package wire

import (
	"context"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/lectorium/orchestrator/internal/config"
	"github.com/jiva-studio/lectorium/orchestrator/internal/handler"
	"github.com/jiva-studio/lectorium/orchestrator/internal/store"
)

// Deps is the assembled dependency graph handed back to the entrypoint. The
// caller owns Pool and must Close it on shutdown.
type Deps struct {
	Pool    *pgxpool.Pool
	Handler http.Handler
}

// Build connects the pool, applies the embedded migrations (advisory-locked,
// idempotent), verifies the schema is current, and wires the HTTP router. On
// any failure it closes whatever it opened and returns a wrapped error, so the
// caller never has to clean up a partial graph.
func Build(ctx context.Context, cfg *config.Config) (*Deps, error) {
	pool, err := store.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	// Apply embedded migrations on boot, then guard against a partial apply.
	if err := store.Migrate(ctx, pool); err != nil {
		pool.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	if err := store.SchemaReady(ctx, pool); err != nil {
		pool.Close()
		return nil, fmt.Errorf("schema not ready: %w", err)
	}

	root := handler.NewRouter(handler.RouterDeps{Pool: pool})
	return &Deps{Pool: pool, Handler: root}, nil
}
