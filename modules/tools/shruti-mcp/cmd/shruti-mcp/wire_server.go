package main

import (
	"net/http"
	"time"

	"github.com/mark3labs/mcp-go/server"

	mcpsrv "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/mcp"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/mcp/tools"
)

// Two MCP transports on one port (mirrors transcriber-mcp): streamable HTTP for
// newer clients, SSE for clients that still expect it.
const (
	streamableHTTPPath = "/mcp"
	ssePath            = "/sse"
)

// mcpHTTP is the HTTP server and the two MCP transports mounted on it. The
// transports are kept so shutdown can stop them before the server: an open
// SSE stream only ends once the SSE server closes its session.
type mcpHTTP struct {
	http       *http.Server
	sse        *server.SSEServer
	streamable *server.StreamableHTTPServer
}

func buildMCPHTTPServer(deps tools.Deps, addr string, heartbeat time.Duration) mcpHTTP {
	srv := mcpsrv.New("shruti-mcp", "0.1.0")
	tools.RegisterAll(srv, deps)

	httpServer := &http.Server{
		Addr:              addr,
		ReadHeaderTimeout: 30 * time.Second,
	}
	streamable := server.NewStreamableHTTPServer(srv,
		server.WithEndpointPath(streamableHTTPPath),
		server.WithHeartbeatInterval(heartbeat),
		server.WithStateLess(true),
	)
	// The SSE server closes its sessions on Shutdown only when it knows the
	// HTTP server it runs in.
	sse := server.NewSSEServer(srv,
		server.WithSSEEndpoint(ssePath),
		server.WithMessageEndpoint("/message"),
		server.WithKeepAliveInterval(heartbeat),
		server.WithHTTPServer(httpServer),
	)

	mux := http.NewServeMux()
	mux.Handle(streamableHTTPPath, streamable)
	mux.Handle(streamableHTTPPath+"/", streamable)
	mux.Handle(ssePath, sse)
	mux.Handle("/message", sse)
	httpServer.Handler = mux

	return mcpHTTP{http: httpServer, sse: sse, streamable: streamable}
}
