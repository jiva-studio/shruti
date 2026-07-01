package provider

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	v1 "github.com/jiva-studio/shruti/proto/v1"
)

// DeepgramKeyEnv holds the Deepgram API key.
const DeepgramKeyEnv = "DEEPGRAM_API_KEY"

// deepgram is a cloud Transcriber: it streams the mixed PCM straight to
// Deepgram's realtime API, which does joint ASR + word-level diarization — so
// speaker attribution is exact (no ASR↔diarizer alignment drift) and it runs
// entirely from the client (no host/streamd). Trade-off: cloud + paid + key.
type deepgram struct{}

// NewDeepgram returns the Deepgram Transcriber.
func NewDeepgram(SessionConfig) Transcriber { return deepgram{} }

func (deepgram) Open(ctx context.Context, cfg SessionConfig) (Session, error) {
	key := os.Getenv(DeepgramKeyEnv)
	if key == "" {
		return nil, fmt.Errorf("deepgram: %s not set", DeepgramKeyEnv)
	}
	lang := cfg.Lang
	if lang == "" {
		lang = "ru"
	}
	// MULTICHANNEL: we send stereo (ch0 = mic = "Я", ch1 = system = "Они") and
	// Deepgram transcribes each channel INDEPENDENTLY — so neither source is
	// drowned by the other (a mono mix let the loud mic mask the quieter system),
	// and speaker attribution is exact by channel (no diarization guessing).
	u := "wss://api.deepgram.com/v1/listen" +
		"?model=nova-2&language=" + lang +
		"&multichannel=true&channels=2&diarize=true&punctuate=true&smart_format=true&interim_results=true" +
		"&encoding=linear16&sample_rate=16000"

	connCtx, cancel := context.WithCancel(context.Background())
	dialCtx, dialCancel := context.WithTimeout(ctx, 10*time.Second)
	defer dialCancel()

	conn, _, err := websocket.Dial(dialCtx, u, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Token " + key}},
	})
	if err != nil {
		cancel()
		return nil, fmt.Errorf("deepgram: dial: %w", err)
	}
	conn.SetReadLimit(1 << 20)

	s := &deepgramSession{
		conn:    conn,
		ctx:     connCtx,
		cancel:  cancel,
		updates: make(chan v1.Update, 64),
		done:    make(chan struct{}),
	}
	go s.readLoop()
	return s, nil
}

type deepgramSession struct {
	conn    *websocket.Conn
	ctx     context.Context
	cancel  context.CancelFunc
	updates chan v1.Update
	done    chan struct{}

	closeOnce sync.Once
}

func (s *deepgramSession) Write(pcm []byte) error {
	return s.conn.Write(s.ctx, websocket.MessageBinary, pcm)
}

func (s *deepgramSession) Updates() <-chan v1.Update { return s.updates }

// dgResult is the subset of Deepgram's streaming JSON we consume.
// channel_index is [thisChannel, totalChannels] under multichannel.
type dgResult struct {
	Type         string `json:"type"`
	IsFinal      bool   `json:"is_final"`
	ChannelIndex []int  `json:"channel_index"`
	Channel      struct {
		Alternatives []struct {
			Transcript string `json:"transcript"`
			Words      []struct {
				Word           string `json:"word"`
				PunctuatedWord string `json:"punctuated_word"`
				Speaker        int    `json:"speaker"`
			} `json:"words"`
		} `json:"alternatives"`
	} `json:"channel"`
}

func (s *deepgramSession) readLoop() {
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
		var r dgResult
		if err := json.Unmarshal(data, &r); err != nil || r.Type != "Results" {
			continue
		}
		if len(r.Channel.Alternatives) == 0 {
			continue
		}
		alt := r.Channel.Alternatives[0]
		if strings.TrimSpace(alt.Transcript) == "" {
			continue
		}
		chIdx := 0
		if len(r.ChannelIndex) > 0 {
			chIdx = r.ChannelIndex[0]
		}
		// ch0 = mic = the user → always "Я".
		if chIdx == 0 {
			utype := v1.TypePartial
			if r.IsFinal {
				utype = v1.TypeFinal
			}
			s.emit(v1.Update{Type: utype, Channel: v1.ChannelMix, Speaker: "Я", Text: alt.Transcript})
			continue
		}
		// ch1 = system: diarize into remote speakers. "Спикер 1" is reserved for
		// "Я", so remote diarizer slots map to "Спикер 2", "Спикер 3", …
		if !r.IsFinal {
			s.emit(v1.Update{Type: v1.TypePartial, Channel: v1.ChannelMix, Speaker: "Они", Text: alt.Transcript})
			continue
		}
		w := alt.Words
		if len(w) == 0 {
			s.emit(v1.Update{Type: v1.TypeFinal, Channel: v1.ChannelMix, Speaker: "Они", Text: alt.Transcript})
			continue
		}
		for i := 0; i < len(w); {
			spk := w[i].Speaker
			var b strings.Builder
			for i < len(w) && w[i].Speaker == spk {
				tok := w[i].PunctuatedWord
				if tok == "" {
					tok = w[i].Word
				}
				if b.Len() > 0 {
					b.WriteByte(' ')
				}
				b.WriteString(tok)
				i++
			}
			s.emit(v1.Update{
				Type:    v1.TypeFinal,
				Channel: v1.ChannelMix,
				Speaker: "Спикер " + strconv.Itoa(spk+2),
				Text:    b.String(),
			})
		}
	}
}

func (s *deepgramSession) emit(u v1.Update) {
	select {
	case s.updates <- u:
	case <-s.ctx.Done():
	}
}

func (s *deepgramSession) Close() error {
	var err error
	s.closeOnce.Do(func() {
		// Ask Deepgram to flush the tail and close.
		writeCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = s.conn.Write(writeCtx, websocket.MessageText, []byte(`{"type":"CloseStream"}`))
		cancel()
		select {
		case <-s.done:
		case <-time.After(8 * time.Second):
		}
		err = s.conn.Close(websocket.StatusNormalClosure, "client closing")
		s.cancel()
	})
	return err
}
