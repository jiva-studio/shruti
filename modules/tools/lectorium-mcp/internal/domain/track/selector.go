package track

import (
	"errors"
	"fmt"
	"time"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/pipeline"
)

// SelectorSource controls where the resolver looks for candidate mp3 files.
//
//   - SourceRegistry: only files already ingested into the lake registry
//     (the `files` table). Required for any registry-only filter (HasPDF,
//     KindTags, StageStatus, LastDoneStage, AuditFallback, Discovered*).
//   - SourceLake: only files on disk under --in that are NOT in the registry
//     yet (i.e. fresh mp3s waiting to be ingested). Registry-only filters
//     are rejected by NewSelector when paired with this source.
//   - SourceBoth: union — registry rows are returned enriched, lake-only
//     rows come back with the minimum (path + path-derived language).
type SelectorSource string

const (
	SourceRegistry SelectorSource = "registry"
	SourceLake     SelectorSource = "lake"
	SourceBoth     SelectorSource = "both"
)

// FallbackSpec narrows the selector to tracks whose latest review pass
// landed at least MinChunks chunks in fallback (i.e. the LLM failed and
// we kept the original raw text). Surfacing these is the input to a
// premium re-run workflow. Requires Selector.EnrichAudit=true.
type FallbackSpec struct {
	MinChunks int
}

// Selector is the single value object every batch tool in lectorium-mcp
// consumes. All fields AND together. Zero/empty fields mean "no filter".
//
// Validation lives in NewSelector — never construct one directly except in
// tests (the literal {} form is fine, defaults will be applied on demand by
// resolvers but invariants aren't checked).
type Selector struct {
	Source SelectorSource

	Languages  []string
	TrackIds   []string
	PathGlob   string
	PathPrefix string

	HasPDF        *bool
	KindTags      []string
	LastDoneStage pipeline.Stage
	StageStatus   map[pipeline.Stage]pipeline.Status

	EnrichAudit    bool
	AuditFallback  *FallbackSpec
	LowConfMinSegs int

	SizeMin int64
	SizeMax int64

	DiscoveredAfter  time.Time
	DiscoveredBefore time.Time

	Limit int
}

// DefaultLimit is the cap NewSelector applies when the caller leaves
// Limit at zero — guard against accidental whole-corpus walks.
const DefaultLimit = 1000

// NewSelector validates and normalizes a Selector value. Returns an error
// for invariants that must hold at the boundary (avoid silent surprises
// downstream).
//
// Rules:
//
//   - Source defaults to SourceBoth when empty.
//   - SourceLake forbids any registry-only filter (HasPDF, KindTags,
//     StageStatus, LastDoneStage, AuditFallback, LowConfMinSegs,
//     DiscoveredAfter/Before). The lake side has no registry to ask.
//   - EnrichAudit must be true when AuditFallback is set or
//     LowConfMinSegs > 0; those signals require reading review.json off
//     disk and we want callers to opt in explicitly.
//   - Limit ≤ 0 → DefaultLimit.
//   - SizeMin/SizeMax must be ≥ 0; SizeMax > 0 must be ≥ SizeMin.
//   - DiscoveredAfter, when both are set, must be ≤ DiscoveredBefore.
func NewSelector(s Selector) (Selector, error) {
	if s.Source == "" {
		s.Source = SourceBoth
	}
	switch s.Source {
	case SourceRegistry, SourceLake, SourceBoth:
	default:
		return Selector{}, fmt.Errorf("selector: unknown source %q", s.Source)
	}

	if s.Source == SourceLake {
		var bad []string
		if s.HasPDF != nil {
			bad = append(bad, "has_pdf")
		}
		if len(s.KindTags) > 0 {
			bad = append(bad, "kind_tags")
		}
		if len(s.StageStatus) > 0 {
			bad = append(bad, "stage_status")
		}
		if s.LastDoneStage != "" {
			bad = append(bad, "last_done_stage")
		}
		if s.AuditFallback != nil {
			bad = append(bad, "audit_fallback")
		}
		if s.LowConfMinSegs > 0 {
			bad = append(bad, "low_conf_min_segs")
		}
		if !s.DiscoveredAfter.IsZero() {
			bad = append(bad, "discovered_after")
		}
		if !s.DiscoveredBefore.IsZero() {
			bad = append(bad, "discovered_before")
		}
		if len(bad) > 0 {
			return Selector{}, fmt.Errorf("selector: source=lake forbids registry-only filters: %v", bad)
		}
	}

	if !s.EnrichAudit {
		if s.AuditFallback != nil {
			return Selector{}, errors.New("selector: audit_fallback requires enrich_audit=true")
		}
		if s.LowConfMinSegs > 0 {
			return Selector{}, errors.New("selector: low_conf_min_segs requires enrich_audit=true")
		}
	}

	if s.AuditFallback != nil && s.AuditFallback.MinChunks <= 0 {
		return Selector{}, errors.New("selector: audit_fallback.min_chunks must be > 0")
	}

	if s.SizeMin < 0 || s.SizeMax < 0 {
		return Selector{}, errors.New("selector: size bounds must be ≥ 0")
	}
	if s.SizeMax > 0 && s.SizeMax < s.SizeMin {
		return Selector{}, fmt.Errorf("selector: size_max (%d) < size_min (%d)", s.SizeMax, s.SizeMin)
	}

	if !s.DiscoveredAfter.IsZero() && !s.DiscoveredBefore.IsZero() && s.DiscoveredAfter.After(s.DiscoveredBefore) {
		return Selector{}, errors.New("selector: discovered_after must be ≤ discovered_before")
	}

	if s.Limit <= 0 {
		s.Limit = DefaultLimit
	}

	return s, nil
}

// IncludesRegistry returns true when the selector touches the registry
// side of the source split. Resolvers use this to short-circuit registry
// SQL when only the lake side is requested.
func (s Selector) IncludesRegistry() bool {
	return s.Source == SourceRegistry || s.Source == SourceBoth
}

// IncludesLake returns true when the selector touches the lake-only side.
// SourceBoth normally implies lake too, but if the caller set any
// registry-only filter (has_pdf, last_done_stage, kind_tags, stage_status,
// audit_*) the lake side is automatically excluded — lake rows have no
// registry record and can't satisfy those filters, so they'd just leak
// through as false positives. NewSelector blocks these filters with
// SourceLake explicitly; here we silently drop the lake side when the
// caller picked SourceBoth and added registry-only filters.
func (s Selector) IncludesLake() bool {
	if s.Source == SourceLake {
		return true
	}
	if s.Source != SourceBoth {
		return false
	}
	return !s.hasRegistryOnlyFilter()
}

// hasRegistryOnlyFilter reports whether sel has any field set that only
// makes sense for ingested files. Used by IncludesLake to skip the lake
// scan when those fields are present under SourceBoth.
func (s Selector) hasRegistryOnlyFilter() bool {
	if len(s.TrackIds) > 0 {
		// Lake files have no track_id assigned until they're ingested.
		// A track_ids filter is by definition asking for registered tracks
		// only; including the lake side leaks every unregistered mp3 in
		// the outbox into the result set.
		return true
	}
	if s.HasPDF != nil {
		return true
	}
	if len(s.KindTags) > 0 {
		return true
	}
	if s.LastDoneStage != "" {
		return true
	}
	if len(s.StageStatus) > 0 {
		return true
	}
	if s.AuditFallback != nil {
		return true
	}
	if s.LowConfMinSegs > 0 {
		return true
	}
	if !s.DiscoveredAfter.IsZero() {
		return true
	}
	if !s.DiscoveredBefore.IsZero() {
		return true
	}
	return false
}
