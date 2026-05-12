package track

import (
	"strings"
	"testing"
	"time"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/pipeline"
)

func TestNewSelectorDefaults(t *testing.T) {
	s, err := NewSelector(Selector{})
	if err != nil {
		t.Fatalf("zero selector should be valid: %v", err)
	}
	if s.Source != SourceBoth {
		t.Errorf("default Source = %q, want %q", s.Source, SourceBoth)
	}
	if s.Limit != DefaultLimit {
		t.Errorf("default Limit = %d, want %d", s.Limit, DefaultLimit)
	}
	if !s.IncludesRegistry() || !s.IncludesLake() {
		t.Errorf("source=both should include both")
	}
}

func TestNewSelectorRejectsUnknownSource(t *testing.T) {
	if _, err := NewSelector(Selector{Source: "garbage"}); err == nil {
		t.Fatal("expected error for unknown source")
	}
}

func TestNewSelectorLakeRejectsRegistryOnlyFilters(t *testing.T) {
	pdf := true
	cases := []struct {
		name string
		sel  Selector
	}{
		{"has_pdf", Selector{Source: SourceLake, HasPDF: &pdf}},
		{"kind_tags", Selector{Source: SourceLake, KindTags: []string{"morning_walk"}}},
		{"stage_status", Selector{Source: SourceLake, StageStatus: map[pipeline.Stage]pipeline.Status{
			pipeline.StageReviewed: pipeline.StatusFailed,
		}}},
		{"last_done_stage", Selector{Source: SourceLake, LastDoneStage: pipeline.StageTranscribed}},
		{"audit_fallback", Selector{Source: SourceLake, EnrichAudit: true, AuditFallback: &FallbackSpec{MinChunks: 3}}},
		{"low_conf_min_segs", Selector{Source: SourceLake, EnrichAudit: true, LowConfMinSegs: 5}},
		{"discovered_after", Selector{Source: SourceLake, DiscoveredAfter: time.Now()}},
		{"discovered_before", Selector{Source: SourceLake, DiscoveredBefore: time.Now()}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := NewSelector(c.sel)
			if err == nil {
				t.Fatalf("expected lake-source rejection for %s", c.name)
			}
			if !strings.Contains(err.Error(), "source=lake") {
				t.Errorf("error missing source=lake hint: %v", err)
			}
		})
	}
}

func TestNewSelectorAuditEnrichmentGate(t *testing.T) {
	if _, err := NewSelector(Selector{
		AuditFallback: &FallbackSpec{MinChunks: 3},
	}); err == nil {
		t.Fatal("audit_fallback without enrich_audit must error")
	}
	if _, err := NewSelector(Selector{
		LowConfMinSegs: 1,
	}); err == nil {
		t.Fatal("low_conf_min_segs without enrich_audit must error")
	}
	if _, err := NewSelector(Selector{
		EnrichAudit:   true,
		AuditFallback: &FallbackSpec{MinChunks: 0},
	}); err == nil {
		t.Fatal("audit_fallback.min_chunks=0 must error")
	}
	// Both gates open: should pass.
	if _, err := NewSelector(Selector{
		EnrichAudit:    true,
		AuditFallback:  &FallbackSpec{MinChunks: 3},
		LowConfMinSegs: 5,
	}); err != nil {
		t.Fatalf("valid audit-enriched selector rejected: %v", err)
	}
}

func TestNewSelectorSizeBounds(t *testing.T) {
	if _, err := NewSelector(Selector{SizeMin: -1}); err == nil {
		t.Fatal("negative size_min must error")
	}
	if _, err := NewSelector(Selector{SizeMax: -1}); err == nil {
		t.Fatal("negative size_max must error")
	}
	if _, err := NewSelector(Selector{SizeMin: 100, SizeMax: 50}); err == nil {
		t.Fatal("size_max < size_min must error")
	}
	// Equal bounds are fine.
	if _, err := NewSelector(Selector{SizeMin: 100, SizeMax: 100}); err != nil {
		t.Fatalf("size_min == size_max should be valid: %v", err)
	}
}

func TestNewSelectorDiscoveredOrdering(t *testing.T) {
	now := time.Now()
	if _, err := NewSelector(Selector{
		DiscoveredAfter:  now,
		DiscoveredBefore: now.Add(-time.Hour),
	}); err == nil {
		t.Fatal("after > before must error")
	}
	if _, err := NewSelector(Selector{
		DiscoveredAfter:  now.Add(-time.Hour),
		DiscoveredBefore: now,
	}); err != nil {
		t.Fatalf("valid range rejected: %v", err)
	}
}

func TestNewSelectorRegistrySourceAllowsAllFilters(t *testing.T) {
	pdf := true
	now := time.Now()
	s, err := NewSelector(Selector{
		Source:           SourceRegistry,
		Languages:        []string{"ru", "en"},
		PathGlob:         "outbox/sorted/ru/**",
		PathPrefix:       "outbox/",
		HasPDF:           &pdf,
		KindTags:         []string{"morning_walk"},
		LastDoneStage:    pipeline.StageTranscribed,
		StageStatus:      map[pipeline.Stage]pipeline.Status{pipeline.StageReviewed: pipeline.StatusFailed},
		EnrichAudit:      true,
		AuditFallback:    &FallbackSpec{MinChunks: 3},
		LowConfMinSegs:   5,
		SizeMin:          1024,
		SizeMax:          10 * 1024 * 1024,
		DiscoveredAfter:  now.Add(-7 * 24 * time.Hour),
		DiscoveredBefore: now,
		Limit:            500,
	})
	if err != nil {
		t.Fatalf("kitchen-sink valid selector rejected: %v", err)
	}
	if s.Limit != 500 {
		t.Errorf("explicit Limit overwritten: %d", s.Limit)
	}
	if s.IncludesLake() {
		t.Errorf("source=registry must not include lake")
	}
}

func TestSelectorSourceIncludes(t *testing.T) {
	cases := []struct {
		src      SelectorSource
		registry bool
		lake     bool
	}{
		{SourceRegistry, true, false},
		{SourceLake, false, true},
		{SourceBoth, true, true},
	}
	for _, c := range cases {
		s := Selector{Source: c.src}
		if got := s.IncludesRegistry(); got != c.registry {
			t.Errorf("%s.IncludesRegistry() = %v, want %v", c.src, got, c.registry)
		}
		if got := s.IncludesLake(); got != c.lake {
			t.Errorf("%s.IncludesLake() = %v, want %v", c.src, got, c.lake)
		}
	}
}

// Regression: SourceBoth + registry-only filter must drop the lake side.
// Otherwise lake mp3s leak into the result with has_pdf=false / no track_id
// and pipeline_run dispatches them as if they were ingested matches —
// caller asks for "english tracks ready for review" and gets every fresh
// english mp3 in the lake too.
func TestIncludesLakeDropsOnRegistryOnlyFilter(t *testing.T) {
	pdf := true
	cases := []struct {
		name string
		sel  Selector
		want bool
	}{
		{"both + track_ids", Selector{Source: SourceBoth, TrackIds: []string{"track_abc"}}, false},
		{"both + has_pdf", Selector{Source: SourceBoth, HasPDF: &pdf}, false},
		{"both + last_done_stage", Selector{Source: SourceBoth, LastDoneStage: pipeline.StageTranscribed}, false},
		{"both + kind_tags", Selector{Source: SourceBoth, KindTags: []string{"morning_walk"}}, false},
		{"both + stage_status", Selector{Source: SourceBoth, StageStatus: map[pipeline.Stage]pipeline.Status{pipeline.StageReviewed: pipeline.StatusFailed}}, false},
		{"both + plain languages keeps lake", Selector{Source: SourceBoth, Languages: []string{"en"}}, true},
		{"both + plain path_glob keeps lake", Selector{Source: SourceBoth, PathGlob: "**/*.mp3"}, true},
		{"explicit lake stays lake", Selector{Source: SourceLake}, true},
		{"empty stays both", Selector{}, false}, // default Source="" → IncludesLake checks Source==SourceBoth which fails
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := c.sel.IncludesLake(); got != c.want {
				t.Errorf("IncludesLake() = %v, want %v", got, c.want)
			}
		})
	}
}
