// Package decider holds the upload strategies the asset sync can be run with.
package decider

import (
	"context"

	assetsport "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/assets"
	s3port "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/s3"
)

// Missing uploads only what the target does not have. Cheapest and the right
// default for append-only assets: a track's audio never changes once published.
type Missing struct{}

func (Missing) Name() string { return "missing" }

func (Missing) Needs(ctx context.Context, t s3port.Uploader, f assetsport.File) (bool, string, error) {
	_, _, exists, err := t.Head(ctx, f.Key)
	if err != nil {
		return false, "", err
	}
	if exists {
		return false, "already there", nil
	}
	return true, "absent", nil
}

// SizeMatch also re-uploads what is there but the wrong length — catches an
// upload cut off mid-transfer, which leaves a short object behind.
type SizeMatch struct{}

func (SizeMatch) Name() string { return "size" }

func (SizeMatch) Needs(ctx context.Context, t s3port.Uploader, f assetsport.File) (bool, string, error) {
	size, _, exists, err := t.Head(ctx, f.Key)
	if err != nil {
		return false, "", err
	}
	switch {
	case !exists:
		return true, "absent", nil
	case size != f.Size:
		return true, "size differs", nil
	default:
		return false, "already there", nil
	}
}

// Force uploads everything without asking. For a target known to be stale.
type Force struct{}

func (Force) Name() string { return "force" }

func (Force) Needs(context.Context, s3port.Uploader, assetsport.File) (bool, string, error) {
	return true, "forced", nil
}

// ByName resolves a strategy name; empty means SizeMatch.
func ByName(name string) (assetsport.Decider, bool) {
	switch name {
	case "", "size":
		return SizeMatch{}, true
	case "missing":
		return Missing{}, true
	case "force":
		return Force{}, true
	default:
		return nil, false
	}
}
