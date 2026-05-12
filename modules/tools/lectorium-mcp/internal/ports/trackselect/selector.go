// Package trackselect is the port the application layer calls to resolve
// a track.Selector into a concrete list of candidates. Concrete adapters
// live in internal/infra/lakeregistry/sqlite (registry-side) and walk the
// filesystem under --in (lake-side); this port hides both.
//
// Naming note: the package is `trackselect` rather than `selector` to
// avoid colliding with catalog.Resolver, which is a totally different
// concept (LLM-based string-to-id resolution).
package trackselect

import (
	"context"
	"time"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/pipeline"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/track"
)

// Selector resolves a track.Selector to a slice of Selected rows. Empty
// result is a valid response (no candidates match) — implementations
// return a non-nil error only on infrastructure failures (sqlite,
// filesystem, etc.).
type Selector interface {
	Select(ctx context.Context, sel track.Selector) ([]Selected, error)
}

// Selected is one candidate path returned by the resolver, with whatever
// metadata is cheap to surface.
//
// Lake-only rows (track.SourceLake or the lake side of SourceBoth) come
// back with TrackId="", LastDone="", KindTag="", HasPDF=false — there is
// no registry record to read from. Path and Language (when derivable
// from outbox/sorted/<lang>/) are still populated.
type Selected struct {
	Path     string
	TrackId  track.Id
	Language string
	HasPDF   bool
	LastDone pipeline.Stage
	KindTag  string

	// Size + DiscoveredAt are always populated when available — for lake
	// rows from os.Stat, for registry rows from the files table.
	Size         int64
	DiscoveredAt time.Time

	// AuditCount is populated only when Selector.EnrichAudit was true
	// and the track has a review.json on disk. Zero-valued otherwise.
	AuditCount AuditMetrics
}

// AuditMetrics aggregates per-track review-quality signals used by the
// audit_review tool and the audit-driven filters (audit_fallback,
// low_conf_min_segs).
type AuditMetrics struct {
	FallbackChunks       int
	LowConfidenceSegs    int
	NoiseFilteredSegs    int
	TotalChunks          int
}
