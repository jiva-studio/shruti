package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"sync"
	"time"

	"github.com/coder/websocket"
	v1 "github.com/jiva-studio/shruti/proto/v1"
)

// DefaultParakeetURL is the streamd WebSocket endpoint reached through the
// tailnet forwarder on yoga (127.0.0.1:18005 → mridanga:8082).
const DefaultParakeetURL = "ws://127.0.0.1:18005" + v1.StreamPath

// parakeet is the default Transcriber: it speaks streamd's WebSocket protocol.
type parakeet struct{}

// NewParakeet returns the parakeet (host/streamd) Transcriber.
func NewParakeet(SessionConfig) Transcriber { return parakeet{} }

func (parakeet) Open(ctx context.Context, cfg SessionConfig) (Session, error) {
	base := cfg.URL
	if base == "" {
		base = DefaultParakeetURL
	}
	u, err := url.Parse(base)
	if err != nil {
		return nil, fmt.Errorf("parakeet: bad url %q: %w", base, err)
	}
	q := u.Query()
	q.Set("channel", cfg.Channel)
	if cfg.Lang != "" {
		q.Set("lang", cfg.Lang)
	}
	u.RawQuery = q.Encode()

	// A background context so the socket outlives the dial context; the
	// session's own cancel func governs its lifetime.
	connCtx, cancel := context.WithCancel(context.Background())
	dialCtx, dialCancel := context.WithTimeout(ctx, 10*time.Second)
	defer dialCancel()

	conn, _, err := websocket.Dial(dialCtx, u.String(), nil)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("parakeet: dial %s: %w", u.String(), err)
	}
	// Raw PCM frames can be large relative to defaults; lift the read limit.
	conn.SetReadLimit(1 << 20)

	s := &parakeetSession{
		conn:    conn,
		ctx:     connCtx,
		cancel:  cancel,
		channel: cfg.Channel,
		updates: make(chan v1.Update, 64),
		done:    make(chan struct{}),
	}
	go s.readLoop()
	return s, nil
}

type parakeetSession struct {
	conn    *websocket.Conn
	ctx     context.Context
	cancel  context.CancelFunc
	channel string
	updates chan v1.Update
	done    chan struct{} // closed when readLoop exits

	closeOnce sync.Once
}

func (s *parakeetSession) Write(pcm []byte) error {
	// PCM is sent as a binary frame, streamed live as captured.
	return s.conn.Write(s.ctx, websocket.MessageBinary, pcm)
}

func (s *parakeetSession) Updates() <-chan v1.Update { return s.updates }

// readLoop reads server text frames (v1.Update JSON) and fans them onto the
// updates channel until the connection ends.
func (s *parakeetSession) readLoop() {
	defer close(s.done)
	defer close(s.updates)
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
		// streamd stamps Channel, but default to our own if absent.
		if up.Channel == "" {
			up.Channel = s.channel
		}
		select {
		case s.updates <- up:
		case <-s.ctx.Done():
			return
		}
	}
}

func (s *parakeetSession) Close() error {
	var err error
	s.closeOnce.Do(func() {
		// Send a Control{close} text frame so the server flushes a final.
		ctrl, _ := json.Marshal(v1.Control{Type: v1.CtrlClose})
		writeCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = s.conn.Write(writeCtx, websocket.MessageText, ctrl)
		cancel()

		// Wait for the server to flush its final(s) (diarization emits them after
		// it gets EOF) and close the connection — readLoop then exits. Without
		// this the socket was torn down before the finals arrived (broken pipe),
		// so no speaker-labelled lines ever reached the UI. Bounded so Stop can't
		// hang.
		select {
		case <-s.done:
		case <-time.After(12 * time.Second):
		}
		err = s.conn.Close(websocket.StatusNormalClosure, "client closing")
		s.cancel()
	})
	return err
}
