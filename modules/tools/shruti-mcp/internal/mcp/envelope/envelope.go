// Package envelope is the canonical response envelope for every MCP tool in
// shruti-mcp.
//
// Three top-level shapes — exactly one is emitted per tool call:
//
//	{"ok": true,  "kind": "<tool>", "result": <payload>}              // sync result
//	{"ok": true,  "kind": "<tool>", "run":    {id, kind, state, ...}} // async dispatch
//	{"ok": false, "kind": "<tool>", "error":  {code, message, details}}
//
// The outer "ok" answers "did the MCP call complete successfully" — it does
// NOT mean "the operation was semantically valid". A track_commit that fails
// validation returns ok:true with result.ok:false; only a transport / argument
// / internal failure flips the outer ok to false.
//
// Every tool MUST go through Result, Run, or Err — never construct envelopes
// by hand. The size cap MaxResponseBytes is informational; tools are
// responsible for their own pagination / limit clamps (see plan §I).
package envelope

import (
	"encoding/json"

	"github.com/mark3labs/mcp-go/mcp"
)

// MaxResponseBytes is the soft cap on a single MCP response body. Tools
// returning lists must default to a small limit and document a max ceiling
// so that no single call exceeds this budget. Naturally large results live
// in runs.db and are retrieved via runs.status.
const MaxResponseBytes = 50 * 1024

// Code is the closed set of error codes a tool may return.
type Code string

const (
	CodeInvalidArgument  Code = "invalid_argument"
	CodeNotFound         Code = "not_found"
	CodeConflict         Code = "conflict"
	CodeValidationFailed Code = "validation_failed"
	CodeDependencyFailed Code = "dependency_failed"
	CodeInternal         Code = "internal"
)

type successResult struct {
	Ok     bool   `json:"ok"`
	Kind   string `json:"kind"`
	Result any    `json:"result,omitempty"`
}

type successRun struct {
	Ok   bool   `json:"ok"`
	Kind string `json:"kind"`
	Run  any    `json:"run"`
}

type errorEnv struct {
	Ok    bool      `json:"ok"`
	Kind  string    `json:"kind"`
	Error errorBody `json:"error"`
}

type errorBody struct {
	Code    Code           `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details"`
}

// Result returns a sync-result envelope for `kind`, embedding `payload`.
// `payload` may be nil — in that case `result` is omitted from the JSON.
func Result(kind string, payload any) *mcp.CallToolResult {
	return marshal(successResult{Ok: true, Kind: kind, Result: payload})
}

// Run returns an async-dispatch envelope for `kind`, embedding `run` (the
// run summary as defined by the tool — typically {id, kind, state,
// accepted_count, rejected_count, rejected?}).
func Run(kind string, run any) *mcp.CallToolResult {
	return marshal(successRun{Ok: true, Kind: kind, Run: run})
}

// Err returns an error envelope. If `code` is empty it defaults to
// CodeInternal. If `details` is nil it is materialized as an empty object so
// downstream code can index into it without nil checks.
func Err(kind string, code Code, message string, details map[string]any) *mcp.CallToolResult {
	if code == "" {
		code = CodeInternal
	}
	if details == nil {
		details = map[string]any{}
	}
	return marshal(errorEnv{
		Ok:   false,
		Kind: kind,
		Error: errorBody{
			Code:    code,
			Message: message,
			Details: details,
		},
	})
}

func marshal(v any) *mcp.CallToolResult {
	body, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		// Falling back to a hand-written error envelope avoids a recursive
		// marshal loop. This branch is essentially unreachable — the input
		// types here only contain JSON-safe shapes.
		return mcp.NewToolResultText(`{"ok":false,"kind":"envelope","error":{"code":"internal","message":"envelope marshal failed","details":{}}}`)
	}
	return mcp.NewToolResultText(string(body))
}
