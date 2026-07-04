package mcpsrv

import (
	"context"
	"encoding/json"
	"os"
	"time"
)

// queryLog is the single structured line emitted per tool call (stdout ->
// docker json-file -> promtail -> Loki). query is user text: treat as
// sensitive, and identify the caller only by a hash, never a raw IP.
type queryLog struct {
	Tool       string         `json:"tool"`
	Query      string         `json:"query,omitempty"`
	Filters    map[string]any `json:"filters,omitempty"`
	Types      []string       `json:"types,omitempty"`
	Count      int            `json:"count"`
	Lang       string         `json:"lang,omitempty"`
	LatencyMs  int64          `json:"latency_ms"`
	VectorMs   *int64         `json:"vector_ms,omitempty"`
	LexicalMs  *int64         `json:"lexical_ms,omitempty"`
	Ts         string         `json:"ts"`
	ClientHash string         `json:"client_hash"`
}

var logEnc = json.NewEncoder(os.Stdout)

// logQuery emits one JSON analytics line for a tool call.
func logQuery(ctx context.Context, tool, query string, filters map[string]any, types []string, count int, lang string, start time.Time) {
	logQueryLanes(ctx, tool, query, filters, types, count, lang, start, nil, nil)
}

// logQueryLanes is logQuery plus the per-lane search timings (vector vs
// lexical, ms) — used by `search` so we can see which lane dominates.
func logQueryLanes(ctx context.Context, tool, query string, filters map[string]any, types []string, count int, lang string, start time.Time, vectorMs, lexicalMs *int64) {
	if len(filters) == 0 {
		filters = nil
	}
	_ = logEnc.Encode(queryLog{
		Tool:       tool,
		Query:      query,
		Filters:    filters,
		Types:      types,
		Count:      count,
		Lang:       lang,
		LatencyMs:  time.Since(start).Milliseconds(),
		VectorMs:   vectorMs,
		LexicalMs:  lexicalMs,
		Ts:         start.UTC().Format(time.RFC3339Nano),
		ClientHash: ClientHash(ctx),
	})
}
