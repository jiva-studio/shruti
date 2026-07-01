// Package ws is the WebSocket boundary of streamd. It accepts a client
// connection on v1.StreamPath, spawns one fluidstreamd child for it, and pumps
// bytes between the two:
//
//	client ──binary frame──▶ child stdin   (live PCM)
//	client ──text frame────▶ v1.Control    (finalize / close)
//	child stdout ──NDJSON──▶ v1.Update ──text frame──▶ client (Channel stamped)
//
// One WebSocket connection == one channel == one fluidstreamd process.
package ws

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"

	"github.com/coder/websocket"
	"github.com/jiva-studio/shruti/host/streamd/internal/engine"
	v1 "github.com/jiva-studio/shruti/proto/v1"
)

// defaultLang is used when the client omits the `lang` query param.
const defaultLang = "ru"

// readLimit caps a single inbound WebSocket message. PCM chunks are small (a
// 160 ms mono s16le@16k frame is ~5 KiB); 1 MiB is comfortably above any frame.
const readLimit = 1 << 20

// Handler returns an http.HandlerFunc for v1.StreamPath. fluidPath is the
// fluidstreamd binary to spawn per connection.
func Handler(fluidPath string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channel := r.URL.Query().Get("channel")
		if channel != v1.ChannelSystem && channel != v1.ChannelMic {
			http.Error(w, "query param 'channel' must be 'system' or 'mic'", http.StatusBadRequest)
			return
		}
		lang := r.URL.Query().Get("lang")
		if lang == "" {
			lang = defaultLang
		}

		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			log.Printf("streamd: ws accept: %v", err)
			return
		}
		conn.SetReadLimit(readLimit)
		// CloseNow is the backstop: it hard-closes the TCP conn on any exit path
		// (a graceful Close below is a no-op if we already closed).
		defer conn.CloseNow()

		// Own the lifetime: cancelling tears the child down (CommandContext) and
		// unblocks conn.Read.
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()

		child, err := engine.Spawn(ctx, fluidPath, lang)
		if err != nil {
			log.Printf("streamd: spawn fluidstreamd (channel=%s): %v", channel, err)
			conn.Close(websocket.StatusInternalError, "engine spawn failed")
			return
		}
		defer child.Kill()

		// Pump 2: child stdout → WebSocket. Ends when the child's stdout closes
		// (EOU/close flush done, process exited), then cancels ctx so pump 1
		// (below) unblocks.
		var wg sync.WaitGroup
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer cancel()
			err := child.Emit(func(u v1.Update) error {
				u.Channel = channel // fluidstreamd doesn't know its channel; we do.
				b, err := json.Marshal(u)
				if err != nil {
					return err
				}
				return conn.Write(ctx, websocket.MessageText, b)
			})
			if err != nil && ctx.Err() == nil {
				log.Printf("streamd: child stream (channel=%s): %v", channel, err)
			}
		}()

		// Pump 1: WebSocket → child stdin. Runs in this goroutine.
		pumpToChild(ctx, conn, child, channel)

		// Teardown: stop everything, reap, then close the socket gracefully.
		cancel()
		wg.Wait()
		_ = child.Wait()
		conn.Close(websocket.StatusNormalClosure, "")
	}
}

// pumpToChild reads client frames until the connection or ctx ends: binary →
// child stdin (live PCM); text → v1.Control.
func pumpToChild(ctx context.Context, conn *websocket.Conn, child *engine.Child, channel string) {
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			return // client closed, ctx cancelled, or read error — all mean "done".
		}
		switch typ {
		case websocket.MessageBinary:
			if _, err := child.Write(data); err != nil {
				log.Printf("streamd: write PCM to child (channel=%s): %v", channel, err)
				return
			}
		case websocket.MessageText:
			var ctrl v1.Control
			if err := json.Unmarshal(data, &ctrl); err != nil {
				log.Printf("streamd: bad control frame (channel=%s): %v", channel, err)
				continue
			}
			switch ctrl.Type {
			case v1.CtrlClose:
				// Close stdin → child flushes the final and exits. We keep
				// reading; the child's exit ends pump 2, which cancels ctx and
				// unblocks this loop.
				if err := child.CloseStdin(); err != nil {
					log.Printf("streamd: close child stdin (channel=%s): %v", channel, err)
				}
			case v1.CtrlFinalize:
				// No-op for now: the EOU manager auto-flushes utterances.
				log.Printf("streamd: finalize (channel=%s) — no-op; EOU auto-flushes", channel)
			default:
				log.Printf("streamd: unknown control type %q (channel=%s)", ctrl.Type, channel)
			}
		}
	}
}
