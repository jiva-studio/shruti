package main

import (
	"net/http"
	"time"

	"github.com/mark3labs/mcp-go/server"

	mcpsrv "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/mcp"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/mcp/tools"
)

// Two MCP transports on one port (mirrors transcriber-mcp): streamable HTTP for
// newer clients, SSE for clients that still expect it.
const (
	streamableHTTPPath = "/mcp"
	ssePath            = "/sse"
)

func buildMCPHTTPServer(deps tools.Deps, addr string, heartbeat time.Duration) *http.Server {
	srv := mcpsrv.New("lectorium-mcp", "0.1.0")
	tools.RegisterAll(srv, deps)

	streamable := server.NewStreamableHTTPServer(srv,
		server.WithEndpointPath(streamableHTTPPath),
		server.WithHeartbeatInterval(heartbeat),
		server.WithStateLess(true),
	)
	sse := server.NewSSEServer(srv,
		server.WithSSEEndpoint(ssePath),
		server.WithMessageEndpoint("/message"),
		server.WithKeepAliveInterval(heartbeat),
	)

	mux := http.NewServeMux()
	mux.Handle(streamableHTTPPath, streamable)
	mux.Handle(streamableHTTPPath+"/", streamable)
	mux.Handle(ssePath, sse)
	mux.Handle("/message", sse)

	return &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 30 * time.Second,
	}
}
