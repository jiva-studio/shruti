// Package mcpsrv builds the lectorium-search MCP server skeleton. Tools are
// registered in tools.go; transport wiring lives in cmd/search-mcp/main.go.
package mcpsrv

import (
	"github.com/mark3labs/mcp-go/server"
)

func New(name, version string) *server.MCPServer {
	return server.NewMCPServer(name, version,
		server.WithToolCapabilities(true),
	)
}
