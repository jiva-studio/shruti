// Package parakeet is the default transcription engine: the Mac host (streamd +
// FluidAudio on the ANE) reached over a WebSocket. It consumes a single mono mix
// (LayoutMixed) — one ASR instance — and the host diarizes it.
package parakeet

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/jiva-studio/shruti/client/internal/domain"
	"github.com/jiva-studio/shruti/client/internal/port"
	v1 "github.com/jiva-studio/shruti/proto/v1"
)

// ID is this engine's provider id.
const ID domain.ProviderID = "parakeet"

// DefaultURL is the streamd WebSocket endpoint reached through the tailnet
// forwarder on yoga (127.0.0.1:18005 → mridanga:8082). Override with SHRUTI_PARAKEET_URL.
const DefaultURL = "ws://127.0.0.1:18005" + v1.StreamPath

// URLEnv overrides the streamd endpoint.
const URLEnv = "SHRUTI_PARAKEET_URL"

// Transcriber is the parakeet engine adapter.
type Transcriber struct{}

// New returns the parakeet transcriber.
func New() port.Transcriber { return Transcriber{} }

// Layout: parakeet takes one mono mix (a single ANE inference; two concurrent
// ones contend).
func (Transcriber) Layout() domain.AudioLayout { return domain.LayoutMixed }

func (Transcriber) Open(ctx context.Context, plan domain.CapturePlan) (port.TranscriptionStream, error) {
	base := DefaultURL
	if v := os.Getenv(URLEnv); v != "" {
		base = v
	}
	u, err := url.Parse(base)
	if err != nil {
		return nil, fmt.Errorf("parakeet: bad url %q: %w", base, err)
	}
	q := u.Query()
	q.Set("channel", string(v1.ChannelMix))
	if lang := plan.PrimaryLanguage(); lang != "" {
		q.Set("lang", string(lang))
	}
	u.RawQuery = q.Encode()

	connCtx, cancel := context.WithCancel(context.Background())
	dialCtx, dialCancel := context.WithTimeout(ctx, 10*time.Second)
	defer dialCancel()

	conn, _, err := websocket.Dial(dialCtx, u.String(), nil)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("parakeet: dial %s: %w", u.String(), err)
	}
	conn.SetReadLimit(1 << 20)

	s := &stream{
		conn:   conn,
		ctx:    connCtx,
		cancel: cancel,
		events: make(chan domain.TranscriptEvent, 64),
		done:   make(chan struct{}),
	}
	go s.readLoop()
	return s, nil
}

type stream struct {
	conn   *websocket.Conn
	ctx    context.Context
	cancel context.CancelFunc
	events chan domain.TranscriptEvent
	done   chan struct{}

	closeOnce sync.Once
}

func (s *stream) Write(frame []byte) error {
	return s.conn.Write(s.ctx, websocket.MessageBinary, frame)
}

func (s *stream) Events() <-chan domain.TranscriptEvent { return s.events }

func (s *stream) readLoop() {
	defer close(s.done)
	defer close(s.events)
	for {
		typ, data, err := s.conn.Read(s.ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageText {
			continue
		}
		var up v1.Update
		if err := json.Unmarshal(data, &up); err != nil {
			continue
		}
		ev := domain.TranscriptEvent{
			Kind:    kindOf(up.Type),
			Speaker: up.Speaker,
			Text:    up.Text,
			Channel: -1, // mixed stream: no distinct source channel
			TsMs:    up.TsMs,
		}
		select {
		case s.events <- ev:
		case <-s.ctx.Done():
			return
		}
	}
}

func kindOf(t string) domain.EventKind {
	if t == v1.TypeFinal {
		return domain.EventFinal
	}
	return domain.EventPartial
}

func (s *stream) Close() error {
	var err error
	s.closeOnce.Do(func() {
		// Ask the server to flush a final, then wait for it (diarization emits
		// finals only after EOF) before tearing down — otherwise the socket
		// closes before the finals arrive (broken pipe) and they are lost.
		ctrl, _ := json.Marshal(v1.Control{Type: v1.CtrlClose})
		writeCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = s.conn.Write(writeCtx, websocket.MessageText, ctrl)
		cancel()
		select {
		case <-s.done:
		case <-time.After(12 * time.Second):
		}
		err = s.conn.Close(websocket.StatusNormalClosure, "client closing")
		s.cancel()
	})
	return err
}
