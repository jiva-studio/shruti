// Package ws is the WebSocket boundary of streamd. It accepts a client
// connection on v1.StreamPath, spawns one fluidstreamd child for it, and pumps
// bytes between the two:
//
//	client ──config frame──▶ session plan   (channels + per-channel speakers)
//	client ──binary frame──▶ mix ──▶ child stdin   (interleaved N-ch PCM → mono)
//	client ──text frame────▶ v1.Control     (finalize / close)
//	child stdout ──NDJSON──▶ v1.Update ──text frame──▶ client (Channel stamped,
//	                                        mixed finals attributed to a source)
//
// The host is authoritative: it mixes the N channels down to the one mono
// stream the ANE can sustain, reports the mode via v1.Status, and re-attributes
// mixed finals to the loudest source channel (per-channel speakers without N
// concurrent model instances).
package ws

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/jiva-studio/shruti/host/streamd/internal/engine"
	"github.com/jiva-studio/shruti/host/streamd/internal/mix"
	v1 "github.com/jiva-studio/shruti/proto/v1"
)

// defaultLang is used when the client omits the `lang` query param.
const defaultLang = "ru"

// readLimit caps a single inbound WebSocket message. Interleaved N-channel PCM
// chunks are still small (a 100 ms stereo s16le@16k frame is ~6.4 KiB); 1 MiB is
// comfortably above any frame.
const readLimit = 1 << 20

// Handler returns an http.HandlerFunc for v1.StreamPath. fluidPath is the
// fluidstreamd binary to spawn per connection.
func Handler(fluidPath string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		channel := r.URL.Query().Get("channel")
		if channel != v1.ChannelSystem && channel != v1.ChannelMic && channel != v1.ChannelMix {
			http.Error(w, "query param 'channel' must be 'system', 'mic' or 'mix'", http.StatusBadRequest)
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
		defer conn.CloseNow()

		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()

		child, err := engine.Spawn(ctx, fluidPath, lang)
		if err != nil {
			log.Printf("streamd: spawn fluidstreamd (channel=%s): %v", channel, err)
			conn.Close(websocket.StatusInternalError, "engine spawn failed")
			return
		}
		defer child.Kill()

		// Shared session state. attrib is published by the config frame (pump 1)
		// and read on finals (pump 2); writeMu serializes the two writers to conn.
		var attrib atomic.Pointer[mix.Attributor]
		var writeMu sync.Mutex
		write := func(b []byte) error {
			writeMu.Lock()
			defer writeMu.Unlock()
			return conn.Write(ctx, websocket.MessageText, b)
		}

		// Pump 2: child stdout → WebSocket. Mixed finals are re-attributed to the
		// loudest source channel when that channel has a fixed speaker.
		var wg sync.WaitGroup
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer cancel()
			err := child.Emit(func(u v1.Update) error {
				u.Channel = channel
				if u.Type == v1.TypeFinal {
					if a := attrib.Load(); a != nil {
						if label, ok := a.DominantSpeaker(); ok {
							u.Speaker = label
						}
					}
				}
				b, err := json.Marshal(u)
				if err != nil {
					return err
				}
				return write(b)
			})
			if err != nil && ctx.Err() == nil {
				log.Printf("streamd: child stream (channel=%s): %v", channel, err)
			}
		}()

		// Pump 1: WebSocket → child stdin (this goroutine).
		pumpToChild(ctx, conn, child, channel, &attrib, write)

		// Teardown: SIGKILL the child up-front, then reap with a bound (a child
		// stuck loading a CoreML model on the ANE would otherwise block Wait).
		cancel()
		child.Kill()
		wg.Wait()
		reaped := make(chan struct{})
		go func() { _ = child.Wait(); close(reaped) }()
		select {
		case <-reaped:
		case <-time.After(3 * time.Second):
			log.Printf("streamd: child reap timed out (channel=%s)", channel)
		}
		conn.Close(websocket.StatusNormalClosure, "")
	}
}

// pumpToChild reads client frames until the connection or ctx ends. The first
// text frame is expected to be a v1.SessionConfig; binary frames are interleaved
// N-channel PCM, de-interleaved + mixed to mono before reaching the child.
func pumpToChild(ctx context.Context, conn *websocket.Conn, child *engine.Child, channel string, attrib *atomic.Pointer[mix.Attributor], write func([]byte) error) {
	channels := 1 // until a config frame says otherwise (legacy clients send mono)
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		switch typ {
		case websocket.MessageBinary:
			frame := data
			if channels > 1 {
				chans := mix.Deinterleave(data, channels)
				if a := attrib.Load(); a != nil {
					a.Observe(chans)
				}
				frame = mix.MixMono(chans)
			}
			if _, err := child.Write(frame); err != nil {
				log.Printf("streamd: write PCM to child (channel=%s): %v", channel, err)
				return
			}
		case websocket.MessageText:
			var probe struct {
				Type string `json:"type"`
			}
			if err := json.Unmarshal(data, &probe); err != nil {
				log.Printf("streamd: bad text frame (channel=%s): %v", channel, err)
				continue
			}
			switch probe.Type {
			case v1.TypeConfig:
				var cfg v1.SessionConfig
				if err := json.Unmarshal(data, &cfg); err != nil {
					log.Printf("streamd: bad config frame (channel=%s): %v", channel, err)
					continue
				}
				channels = configure(cfg, attrib)
				st, _ := json.Marshal(v1.Status{
					Type: v1.TypeStatus, Mode: v1.ModeMixed, Reason: "ane_capacity", Channels: channels,
				})
				_ = write(st)
				log.Printf("streamd: session config: channels=%d mode=mixed", channels)
			case v1.CtrlClose:
				if err := child.CloseStdin(); err != nil {
					log.Printf("streamd: close child stdin (channel=%s): %v", channel, err)
				}
			case v1.CtrlFinalize:
				log.Printf("streamd: finalize (channel=%s) — no-op; EOU auto-flushes", channel)
			default:
				log.Printf("streamd: unknown text type %q (channel=%s)", probe.Type, channel)
			}
		}
	}
}

// configure installs an attributor for the plan and returns the channel count.
func configure(cfg v1.SessionConfig, attrib *atomic.Pointer[mix.Attributor]) int {
	channels := cfg.Channels
	if channels < 1 {
		channels = 1
	}
	speakers := make([]string, channels)
	for i, s := range cfg.Sources {
		if i < channels {
			speakers[i] = s.Speaker
		}
	}
	attrib.Store(mix.NewAttributor(speakers))
	return channels
}
