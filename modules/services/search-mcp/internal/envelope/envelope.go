// Package envelope is the canonical response envelope for every MCP tool in
// lectorium-search. It mirrors lectorium-mcp's envelope so a client speaking
// to both servers sees one response contract.
//
// Two top-level shapes — exactly one is emitted per tool call:
//
//	{"ok": true,  "kind": "<tool>", "result": <payload>}
//	{"ok": false, "kind": "<tool>", "error":  {code, message, details}}
//
// This service is read-only, so there is no async "run" shape (lectorium-mcp
// has one for its pipeline jobs). Every tool MUST go through Result or Err —
// never construct envelopes by hand.
package envelope

import (
	"encoding/json"

	"github.com/mark3labs/mcp-go/mcp"
)

// Code is the closed set of error codes a tool may return.
type Code string

const (
	CodeInvalidArgument  Code = "invalid_argument"
	CodeNotFound         Code = "not_found"
	CodeDependencyFailed Code = "dependency_failed"
	CodeInternal         Code = "internal"
)

type successResult struct {
	Ok     bool   `json:"ok"`
	Kind   string `json:"kind"`
	Result any    `json:"result,omitempty"`
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

// Result returns a sync-result envelope for kind, embedding payload.
func Result(kind string, payload any) *mcp.CallToolResult {
	return marshal(successResult{Ok: true, Kind: kind, Result: payload})
}

// Err returns an error envelope. Empty code defaults to CodeInternal; nil
// details is materialized as an empty object so callers can index safely.
func Err(kind string, code Code, message string, details map[string]any) *mcp.CallToolResult {
	if code == "" {
		code = CodeInternal
	}
	if details == nil {
		details = map[string]any{}
	}
	return marshal(errorEnv{
		Ok:    false,
		Kind:  kind,
		Error: errorBody{Code: code, Message: message, Details: details},
	})
}

func marshal(v any) *mcp.CallToolResult {
	body, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return mcp.NewToolResultText(`{"ok":false,"kind":"envelope","error":{"code":"internal","message":"envelope marshal failed","details":{}}}`)
	}
	return mcp.NewToolResultText(string(body))
}
