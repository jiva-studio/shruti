package reports

import (
	"context"
	"fmt"
	"net/url"
	"time"
)

// libraryTotalsResult is raw catalog data: how many lectures the library holds
// and their combined runtime. No derived formatting — the client renders it.
type libraryTotalsResult struct {
	LectureCount     int64 `json:"lecture_count"`
	TotalDurationMs  int64 `json:"total_duration_ms"`
	TotalDurationSec int64 `json:"total_duration_seconds"`
}

// LibraryTotals implements the library_totals report.
//
//	GET /analytics/reports/library_totals
//
// It reads the CDN-published catalog (via deps.Catalog) — lecture count and
// summed runtime. The catalog only changes when a new version is published, so
// this is cached for a day.
func LibraryTotals(ctx context.Context, deps Deps, _ url.Values) (any, map[string]any, error) {
	if deps.Catalog == nil {
		return nil, nil, fmt.Errorf("catalog provider not configured")
	}
	t, err := deps.Catalog.Totals(ctx)
	if err != nil {
		return nil, nil, err
	}
	result := libraryTotalsResult{
		LectureCount:     t.LectureCount,
		TotalDurationMs:  t.TotalDurationMs,
		TotalDurationSec: t.TotalDurationMs / 1000,
	}
	return result, map[string]any{}, nil
}

func init() {
	Register(Report{
		Name: "library_totals",
		TTL:  24 * time.Hour,
		Fn:   LibraryTotals,
	})
}
