// Package adminconfig is the application service backing admin_config_get
// and admin_config_set. It validates the requested path against
// domain.WritablePaths(), invokes the appropriate port to apply the
// change, and returns a structured result.
//
// The MCP tool description text is generated from
// domain.PatternsForDescription() so the docs can't drift from code; the
// MCP handler is a thin marshal/unmarshal dispatcher (see
// internal/mcp/tools/admin.go).
package adminconfig

import (
	"context"
	"fmt"
	"strings"

	domain "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/adminconfig"
	port "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/adminconfig"
)

// Service wires the ports the apply / snapshot operations need. Either
// port may be a fake in tests.
type Service struct {
	Endpoints port.EndpointMutator
	Defaults  port.DefaultMutator
	Snap      port.SnapshotProvider
}

// Result is the structured outcome of an Apply call. Mirrors the
// pre-v2 admin_config_set response shape so the MCP envelope can
// embed it directly.
type Result struct {
	Path      string   `json:"path"`
	Previous  string   `json:"previous,omitempty"`
	Current   string   `json:"current"`
	Available []string `json:"available,omitempty"`
}

// ErrNotSettable is returned when a path doesn't match any
// domain.WritablePaths() entry. The MCP handler maps this to
// envelope.CodeInvalidArgument and includes the full allowlist in the
// error details.
type ErrNotSettable struct {
	Path    string
	Allowed []string
}

func (e *ErrNotSettable) Error() string {
	return fmt.Sprintf("path %q is not settable. Allowed: %s", e.Path, strings.Join(e.Allowed, ", "))
}

// ErrValidation wraps a domain validator failure so the MCP handler can
// emit envelope.CodeInvalidArgument cleanly.
type ErrValidation struct{ Err error }

func (e *ErrValidation) Error() string { return e.Err.Error() }
func (e *ErrValidation) Unwrap() error { return e.Err }

// Apply matches the requested path against the WritablePaths table,
// validates the value, and dispatches to the relevant port. Returns
// ErrNotSettable when no rule matches, ErrValidation on validator
// failure, or the underlying port error wrapped on apply failure.
func (s Service) Apply(ctx context.Context, path, value string) (Result, error) {
	for _, wp := range domain.WritablePaths() {
		params, ok := wp.Match(path)
		if !ok {
			continue
		}
		if err := wp.Validate(value); err != nil {
			return Result{}, &ErrValidation{Err: err}
		}
		switch wp.Pattern {
		case "transcribe.default":
			prev, available, err := s.Defaults.SetDefaultTranscriber(ctx, value)
			if err != nil {
				return Result{}, fmt.Errorf("apply %s: %w", path, err)
			}
			return Result{Path: path, Previous: prev, Current: value, Available: available}, nil
		case "transcribe.providers.*.endpoint":
			name := params["name"]
			prev, err := s.Endpoints.SetTranscriberEndpoint(ctx, name, value)
			if err != nil {
				return Result{}, fmt.Errorf("apply %s: %w", path, err)
			}
			return Result{Path: path, Previous: prev, Current: value}, nil
		}
		// Pattern present in WritablePaths() but no dispatch case here:
		// internal bug, surfaces to the caller as a clear "missing
		// dispatch" rather than the silent "not settable" the old code
		// produced.
		return Result{}, fmt.Errorf("dispatch missing for pattern %q (add a case in application/adminconfig.Apply)", wp.Pattern)
	}
	return Result{}, &ErrNotSettable{Path: path, Allowed: domain.PatternsForDescription()}
}

// Snapshot returns the live (sanitized + overlay) config tree for
// admin_config_get.
func (s Service) Snapshot(ctx context.Context) (map[string]any, error) {
	return s.Snap.Snapshot(ctx)
}
