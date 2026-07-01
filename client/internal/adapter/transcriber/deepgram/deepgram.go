// Package deepgram is a cloud transcription engine: it streams interleaved
// N-channel PCM to Deepgram's realtime API, which transcribes each channel
// independently (LayoutMultiChannel) and, per channel, either uses the source's
// fixed speaker label or diarizes into "Спикер N". Runs entirely from the client.
package deepgram

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
	"github.com/jiva-studio/shruti/client/internal/domain"
	"github.com/jiva-studio/shruti/client/internal/port"
)

// ID is this engine's provider id.
const ID domain.ProviderID = "deepgram"

// KeyEnv holds the Deepgram API key.
const KeyEnv = "DEEPGRAM_API_KEY"

// model is Deepgram's current multilingual streaming model (nova-2 is retired).
const model = "nova-3"

// Transcriber is the Deepgram engine adapter.
type Transcriber struct{}

// New returns the Deepgram transcriber.
func New() port.Transcriber { return Transcriber{} }

// Layout: Deepgram transcribes each interleaved channel independently.
func (Transcriber) Layout() domain.AudioLayout { return domain.LayoutMultiChannel }

func (Transcriber) Open(ctx context.Context, plan domain.CapturePlan) (port.TranscriptionStream, error) {
	key := os.Getenv(KeyEnv)
	if key == "" {
		return nil, fmt.Errorf("deepgram: %s not set", KeyEnv)
	}
	channels := plan.Channels()
	if channels == 0 {
		return nil, fmt.Errorf("deepgram: plan has no channels")
	}
	// One channel per source, each transcribed independently; diarize so a
	// channel without a fixed speaker (e.g. shared system audio) is still split.
	u := "wss://api.deepgram.com/v1/listen" +
		"?model=" + model +
		"&language=" + string(plan.PrimaryLanguage()) +
		"&multichannel=true&channels=" + strconv.Itoa(channels) +
		"&diarize=true&punctuate=true&smart_format=true&interim_results=true" +
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

	s := &stream{
		conn:     conn,
		ctx:      connCtx,
		cancel:   cancel,
		speakers: speakerLabels(plan.Sources),
		events:   make(chan domain.TranscriptEvent, 64),
		done:     make(chan struct{}),
	}
	go s.readLoop()
	return s, nil
}

// speakerLabels maps channel index → fixed speaker label ("" = diarize).
func speakerLabels(sources []domain.Source) map[int]string {
	m := make(map[int]string, len(sources))
	for _, src := range sources {
		m[src.Channel] = src.Speaker
	}
	return m
}

type stream struct {
	conn     *websocket.Conn
	ctx      context.Context
	cancel   context.CancelFunc
	speakers map[int]string
	events   chan domain.TranscriptEvent
	done     chan struct{}

	closeOnce sync.Once
}

func (s *stream) Write(frame []byte) error {
	return s.conn.Write(s.ctx, websocket.MessageBinary, frame)
}

func (s *stream) Events() <-chan domain.TranscriptEvent { return s.events }

// dgResult is the subset of Deepgram's streaming JSON we consume.
type dgResult struct {
	Type         string `json:"type"`
	IsFinal      bool   `json:"is_final"`
	ChannelIndex []int  `json:"channel_index"` // [thisChannel, totalChannels]
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
		kind := domain.EventPartial
		if r.IsFinal {
			kind = domain.EventFinal
		}

		// A channel with a fixed speaker (a dedicated mic) is attributed wholesale.
		if label := s.speakers[chIdx]; label != "" {
			s.emit(domain.TranscriptEvent{Kind: kind, Speaker: label, Text: alt.Transcript, Channel: chIdx})
			continue
		}
		// Otherwise diarize. Interim results have no words → emit as a generic
		// "Спикер". Finals split by Deepgram's per-word speaker id.
		if !r.IsFinal || len(alt.Words) == 0 {
			s.emit(domain.TranscriptEvent{Kind: kind, Speaker: "Спикер", Text: alt.Transcript, Channel: chIdx})
			continue
		}
		for i := 0; i < len(alt.Words); {
			spk := alt.Words[i].Speaker
			var b strings.Builder
			for i < len(alt.Words) && alt.Words[i].Speaker == spk {
				tok := alt.Words[i].PunctuatedWord
				if tok == "" {
					tok = alt.Words[i].Word
				}
				if b.Len() > 0 {
					b.WriteByte(' ')
				}
				b.WriteString(tok)
				i++
			}
			s.emit(domain.TranscriptEvent{
				Kind:    domain.EventFinal,
				Speaker: "Спикер " + strconv.Itoa(spk+1),
				Text:    b.String(),
				Channel: chIdx,
			})
		}
	}
}

func (s *stream) emit(ev domain.TranscriptEvent) {
	select {
	case s.events <- ev:
	case <-s.ctx.Done():
	}
}

func (s *stream) Close() error {
	var err error
	s.closeOnce.Do(func() {
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
