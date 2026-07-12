// Package reports is the registry of named analytics reports.
//
// A report is intentionally DUMB: given input params it returns raw data
// (e.g. listening seconds per day for a date range). All derived logic —
// rates, extrapolation, formatting — lives on the client that consumes it.
// Adding a report is one Register call; the HTTP layer stays generic.
package reports

import (
	"context"
	"net/url"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti/analytics/internal/catalog"
)

// Deps are the data sources a report may read. Each report uses only what it
// needs — listening_daily reads Pool (profile DB), library_totals reads
// Catalog (the CDN-published lecture catalog).
type Deps struct {
	Pool    *pgxpool.Pool
	Catalog *catalog.Provider
}

// Func computes one report. It validates/normalizes the query params itself
// and returns the raw result payload plus the normalized params actually
// applied (defaults filled in) so the HTTP envelope can echo them.
//
// Invalid input must be reported via BadParam so the handler maps it to a
// 400 invalid_params; any other error is treated as a 500.
type Func func(ctx context.Context, deps Deps, q url.Values) (result any, params map[string]any, err error)

// Report binds a name and cache TTL to its compute function.
type Report struct {
	Name string
	TTL  time.Duration
	Fn   Func
}

var registry = map[string]Report{}

// Register adds a report to the global registry (called from each report's
// init). A duplicate name panics at startup — a programming error.
func Register(r Report) {
	if _, dup := registry[r.Name]; dup {
		panic("reports: duplicate report name " + r.Name)
	}
	registry[r.Name] = r
}

// Get looks up a report by name.
func Get(name string) (Report, bool) {
	r, ok := registry[name]
	return r, ok
}

// Names returns the registered report names (unordered) — handy for docs /
// a discovery endpoint later.
func Names() []string {
	out := make([]string, 0, len(registry))
	for n := range registry {
		out = append(out, n)
	}
	return out
}

// ParamError marks a caller-input problem (bad/missing param). The handler
// turns it into a 400 with code "invalid_params".
type ParamError struct{ Msg string }

func (e *ParamError) Error() string { return e.Msg }

// BadParam builds a ParamError.
func BadParam(msg string) error { return &ParamError{Msg: msg} }
