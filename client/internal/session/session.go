// Package session orchestrates a live meeting: it captures system + microphone,
// MIXES them into a single stream, opens one transcription session, pumps the
// mixed PCM in, fans-in the Update stream to the UI, and on stop builds the
// transcript, summarizes it, and persists everything.
//
// Single stream (not one-per-channel) avoids two concurrent Nemotron inferences
// contending on the ANE (which starved one channel). Speaker separation comes
// from diarization on this one stream (added on top of ASR).
package session

import (
	"context"
	"encoding/binary"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/jiva-studio/shruti/client/internal/capture"
	"github.com/jiva-studio/shruti/client/internal/provider"
	"github.com/jiva-studio/shruti/client/internal/store"
	"github.com/jiva-studio/shruti/client/internal/summary"
	v1 "github.com/jiva-studio/shruti/proto/v1"
)

// Config configures a meeting session.
type Config struct {
	// Provider selects the transcription provider ("" = parakeet).
	Provider string
	// URL overrides the provider endpoint ("" = provider default).
	URL string
	// Lang is the ASR language hint (e.g. "ru").
	Lang string
	// SystemDevice / MicDevice are PipeWire node ids chosen in the UI (system =
	// a sink whose monitor we capture; mic = a source). Both are captured and
	// mixed into one stream. Empty → auto-detect the defaults.
	SystemDevice string
	MicDevice    string
}

// Session is a running meeting orchestration.
type Session struct {
	cfg  Config
	emit func(v1.Update)

	cap        *capture.Capture
	sess       provider.Session
	summarizer summary.Summarizer

	startedAt time.Time

	mu     sync.Mutex
	finals []v1.Update // committed segments, in arrival order

	fanWG   sync.WaitGroup
	pumpWG  sync.WaitGroup
	stopped bool
}

// Start begins capture + transcription. emit is called for every Update
// (partial and final) so the UI can render live subtitles. summarizer may be
// nil, in which case Stop skips summarization.
func Start(ctx context.Context, cfg Config, summarizer summary.Summarizer, emit func(v1.Update)) (*Session, error) {
	trans, err := provider.New(cfg.Provider, provider.SessionConfig{URL: cfg.URL, Lang: cfg.Lang})
	if err != nil {
		return nil, err
	}

	var cap *capture.Capture
	if cfg.SystemDevice != "" && cfg.MicDevice != "" {
		cap, err = capture.StartOn(ctx, []capture.Source{
			{Channel: v1.ChannelSystem, Target: cfg.SystemDevice, Name: cfg.SystemDevice},
			{Channel: v1.ChannelMic, Target: cfg.MicDevice, Name: cfg.MicDevice},
		}, "pipewire")
	} else {
		cap, err = capture.Start(ctx)
	}
	if err != nil {
		return nil, err
	}
	for _, src := range cap.Sources() {
		log.Printf("capture source: channel=%s target=%s name=%s", src.Channel, src.Target, src.Name)
	}

	// One transcription session over the mixed stream.
	sess, err := trans.Open(ctx, provider.SessionConfig{URL: cfg.URL, Channel: v1.ChannelMix, Lang: cfg.Lang})
	if err != nil {
		cap.Stop()
		return nil, fmt.Errorf("session: open stream: %w", err)
	}

	s := &Session{
		cfg:        cfg,
		emit:       emit,
		cap:        cap,
		sess:       sess,
		summarizer: summarizer,
		startedAt:  time.Now(),
	}

	// Deepgram transcribes per-channel, so send STEREO (mic=ch0="Я",
	// system=ch1="Они"); everyone else gets the mono mix.
	var audio <-chan []byte
	if cfg.Provider == "deepgram" {
		audio = interleaveStereo(cap.Frames(v1.ChannelMic), cap.Frames(v1.ChannelSystem))
	} else {
		audio = mixStreams(cap.Frames(v1.ChannelSystem), cap.Frames(v1.ChannelMic))
	}
	s.pump(audio, sess)
	s.fanIn(sess)

	return s, nil
}

// interleaveStereo weaves two mono s16le streams into one interleaved stereo
// stream: a → left (channel 0), b → right (channel 1).
func interleaveStereo(a, b <-chan []byte) <-chan []byte {
	out := make(chan []byte, 32)
	go func() {
		defer close(out)
		for {
			fa, oka := <-a
			fb, okb := <-b
			if !oka && !okb {
				return
			}
			out <- interleavePCM(fa, fb)
		}
	}()
	return out
}

func interleavePCM(a, b []byte) []byte {
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	n -= n % 2
	out := make([]byte, n*2)
	for i, j := 0, 0; i < n; i, j = i+2, j+4 {
		out[j], out[j+1] = a[i], a[i+1] // left = a (ch0)
		out[j+2], out[j+3] = b[i], b[i+1] // right = b (ch1)
	}
	return out
}

// mixStreams sums two continuous PCM frame streams (s16le) into one. Both
// pw-record sources produce frames at the same rate, so pairing them 1:1 keeps
// them roughly time-aligned; samples are summed with clipping.
func mixStreams(a, b <-chan []byte) <-chan []byte {
	out := make(chan []byte, 32)
	go func() {
		defer close(out)
		for {
			fa, oka := <-a
			fb, okb := <-b
			if !oka && !okb {
				return
			}
			out <- mixPCM(fa, fb)
		}
	}()
	return out
}

func mixPCM(a, b []byte) []byte {
	n := len(a)
	if len(b) < n {
		n = len(b)
	}
	n -= n % 2
	if n == 0 {
		if len(a) >= len(b) {
			return a
		}
		return b
	}
	out := make([]byte, n)
	for i := 0; i < n; i += 2 {
		sa := int32(int16(binary.LittleEndian.Uint16(a[i:])))
		sb := int32(int16(binary.LittleEndian.Uint16(b[i:])))
		s := sa + sb
		if s > 32767 {
			s = 32767
		} else if s < -32768 {
			s = -32768
		}
		binary.LittleEndian.PutUint16(out[i:], uint16(int16(s)))
	}
	return out
}

// pump forwards mixed PCM frames into the provider session until drained.
func (s *Session) pump(frames <-chan []byte, sess provider.Session) {
	s.pumpWG.Add(1)
	go func() {
		defer s.pumpWG.Done()
		var total, logged int64
		for pcm := range frames {
			total += int64(len(pcm))
			if total-logged >= 64000 { // ~2 s of 16 kHz audio
				log.Printf("capture[mix]: %d KB streamed", total/1000)
				logged = total
			}
			if err := sess.Write(pcm); err != nil {
				log.Printf("capture[mix]: write error after %d B: %v", total, err)
				return
			}
		}
		log.Printf("capture[mix]: ended, %d B total", total)
	}()
}

// fanIn consumes the session's Updates, emitting each to the UI and recording
// finals into the in-memory transcript.
func (s *Session) fanIn(sess provider.Session) {
	s.fanWG.Add(1)
	go func() {
		defer s.fanWG.Done()
		for up := range sess.Updates() {
			log.Printf("update: type=%s speaker=%s textlen=%d", up.Type, up.Speaker, len(up.Text))
			if up.Type == v1.TypeFinal {
				s.mu.Lock()
				s.finals = append(s.finals, up)
				s.mu.Unlock()
			}
			if s.emit != nil {
				s.emit(up)
			}
		}
	}()
}

// Stop ends capture and transcription, builds the transcript, summarizes it,
// persists transcript + summary, and returns the summary. Safe to call once.
func (s *Session) Stop(ctx context.Context) (string, error) {
	s.mu.Lock()
	if s.stopped {
		s.mu.Unlock()
		return "", nil
	}
	s.stopped = true
	s.mu.Unlock()

	s.cap.Stop()
	s.pumpWG.Wait()
	_ = s.sess.Close()
	s.fanWG.Wait()

	s.mu.Lock()
	finals := make([]v1.Update, len(s.finals))
	copy(finals, s.finals)
	s.mu.Unlock()

	transcript := BuildTranscript(finals)

	meeting, err := store.NewMeeting(s.startedAt)
	if err != nil {
		return "", fmt.Errorf("session: open meeting store: %w", err)
	}
	if err := meeting.WriteTranscript(finals); err != nil {
		return "", err
	}

	var summaryText string
	if s.summarizer != nil && transcript != "" {
		summaryText, err = s.summarizer.Summarize(ctx, transcript)
		if err != nil {
			_ = meeting.WriteSummary("(резюме не сгенерировано: " + err.Error() + ")")
			return "", err
		}
		if err := meeting.WriteSummary(summaryText); err != nil {
			return summaryText, err
		}
	}

	return summaryText, nil
}

// BuildTranscript renders finals into a readable transcript, prefixing each line
// with its speaker label when diarization provides one.
func BuildTranscript(finals []v1.Update) string {
	var b []byte
	for _, u := range finals {
		if u.Speaker != "" {
			b = append(b, u.Speaker...)
			b = append(b, ": "...)
		}
		b = append(b, u.Text...)
		b = append(b, '\n')
	}
	return string(b)
}
