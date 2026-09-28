package handler

import (
	"time"

	"github.com/jiva-studio/shruti/discovery/internal/domain"
)

// runOut is a pass over a source as the API shows it: on its own, in the list
// of runs, and as a source's last pass.
type runOut struct {
	ID             int64          `json:"id"`
	SourceID       *string        `json:"source_id,omitempty"`
	DryRun         bool           `json:"dry_run"`
	StartedAt      time.Time      `json:"started_at"`
	FinishedAt     *time.Time     `json:"finished_at,omitempty"`
	PagesFetched   int            `json:"pages_fetched"`
	PagesUnchanged int            `json:"pages_unchanged"`
	ItemsFound     int            `json:"items_found"`
	ItemsNew       int            `json:"items_new"`
	ItemsChanged   int            `json:"items_changed"`
	Failures       int            `json:"failures"`
	Errors         map[string]int `json:"errors,omitempty"`
	Interrupted    bool           `json:"interrupted,omitempty"`
}

func runFrom(r *domain.Run) *runOut {
	if r == nil {
		return nil
	}
	return &runOut{
		ID:             r.ID,
		SourceID:       r.SourceID,
		DryRun:         r.DryRun,
		StartedAt:      r.StartedAt,
		FinishedAt:     r.FinishedAt,
		PagesFetched:   r.PagesFetched,
		PagesUnchanged: r.PagesUnchanged,
		ItemsFound:     r.ItemsFound,
		ItemsNew:       r.ItemsNew,
		ItemsChanged:   r.ItemsChanged,
		Failures:       r.Failures,
		Errors:         r.Errors,
		Interrupted:    r.Interrupted,
	}
}

// runsFrom keeps a nil list nil, so an empty listing still reads as null.
func runsFrom(runs []domain.Run) []runOut {
	if runs == nil {
		return nil
	}
	out := make([]runOut, 0, len(runs))
	for i := range runs {
		out = append(out, *runFrom(&runs[i]))
	}
	return out
}
