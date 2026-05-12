package mcpsrv

import (
	"github.com/mark3labs/mcp-go/server"
)

// New creates the MCP server skeleton. Tools are registered separately in
// internal/mcp/tools/*.go via RegisterAll. The HTTP transports (streamable
// HTTP + SSE) are wired up in cmd/lectorium-mcp/main.go.
func New(name, version string) *server.MCPServer {
	return server.NewMCPServer(name, version,
		server.WithToolCapabilities(true),
	)
}
