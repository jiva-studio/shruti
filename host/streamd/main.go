// Command streamd is the host-side WebSocket server for Shruti. It runs on the
// Mac (mridanga), next to fluidstreamd, and is the network boundary the Linux
// client talks to.
//
// Per accepted WebSocket connection on v1.StreamPath it:
//  1. reads channel/lang from the query,
//  2. spawns one fluidstreamd child (models load once per session; amortized
//     over a meeting),
//  3. pumps incoming binary PCM frames into the child's stdin,
//  4. reads the child's stdout NDJSON, stamps Channel, and relays each line to
//     the client as a WebSocket text frame (v1.Update),
//  5. on a v1.Control{CtrlFinalize|CtrlClose} text frame, closes the child's
//     stdin so it flushes a final, then tears down.
//
// NOTE: this is the frozen-contract scaffold. The WebSocket accept loop and the
// child-process pump live in ./internal/ws and ./internal/engine (see task #3).
package main

import (
	"flag"
	"log"
	"net/http"

	"github.com/jiva-studio/shruti/host/streamd/internal/ws"
	v1 "github.com/jiva-studio/shruti/proto/v1"
)

func main() {
	addr := flag.String("addr", ":8082", "listen address")
	fluidPath := flag.String("fluidstreamd", "fluidstreamd", "path to the fluidstreamd binary")
	flag.Parse()

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc(v1.StreamPath, ws.Handler(*fluidPath))

	log.Printf("streamd listening on %s (fluidstreamd=%s)", *addr, *fluidPath)
	log.Fatal(http.ListenAndServe(*addr, mux))
}
