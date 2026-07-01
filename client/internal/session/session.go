// Package session orchestrates a live meeting: it captures the two audio
// streams, opens one transcription session per channel, pumps PCM into each,
// fans-in the Update streams to the UI, and on stop builds the transcript,
// summarizes it, and persists everything.
package session

import (
	"context"
	"fmt"
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
}

// Session is a running meeting orchestration.
type Session struct {
	cfg  Config
	emit func(v1.Update)

	cap        *capture.Capture
	sysSession provider.Session
	micSession provider.Session
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

	cap, err := capture.Start(ctx)
	if err != nil {
		return nil, err
	}

	sysSess, err := trans.Open(ctx, provider.SessionConfig{URL: cfg.URL, Channel: v1.ChannelSystem, Lang: cfg.Lang})
	if err != nil {
		cap.Stop()
		return nil, fmt.Errorf("session: open system stream: %w", err)
	}
	micSess, err := trans.Open(ctx, provider.SessionConfig{URL: cfg.URL, Channel: v1.ChannelMic, Lang: cfg.Lang})
	if err != nil {
		_ = sysSess.Close()
		cap.Stop()
		return nil, fmt.Errorf("session: open mic stream: %w", err)
	}

	s := &Session{
		cfg:        cfg,
		emit:       emit,
		cap:        cap,
		sysSession: sysSess,
		micSession: micSess,
		summarizer: summarizer,
		startedAt:  time.Now(),
	}

	// Pump captured PCM into each provider session.
	s.pump(cap.System(), sysSess)
	s.pump(cap.Mic(), micSess)

	// Fan-in Updates from both sessions.
	s.fanIn(sysSess)
	s.fanIn(micSess)

	return s, nil
}

// pump forwards PCM frames from a capture channel into a provider session until
// the channel is drained.
func (s *Session) pump(frames <-chan []byte, sess provider.Session) {
	s.pumpWG.Add(1)
	go func() {
		defer s.pumpWG.Done()
		for pcm := range frames {
			if err := sess.Write(pcm); err != nil {
				return // session closed / socket error
			}
		}
	}()
}

// fanIn consumes a session's Updates, emitting each to the UI and recording
// finals into the in-memory transcript.
func (s *Session) fanIn(sess provider.Session) {
	s.fanWG.Add(1)
	go func() {
		defer s.fanWG.Done()
		for up := range sess.Updates() {
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
// persists transcript + summary, and returns the summary. It is safe to call
// once; subsequent calls are no-ops returning "".
func (s *Session) Stop(ctx context.Context) (string, error) {
	s.mu.Lock()
	if s.stopped {
		s.mu.Unlock()
		return "", nil
	}
	s.stopped = true
	s.mu.Unlock()

	// Stop capture first so the pumps drain and stop writing.
	s.cap.Stop()
	s.pumpWG.Wait()

	// Close provider sessions: sends Control{close}, flushes a last final.
	_ = s.sysSession.Close()
	_ = s.micSession.Close()

	// Wait for the fan-in goroutines to drain remaining Updates.
	s.fanWG.Wait()

	s.mu.Lock()
	finals := make([]v1.Update, len(s.finals))
	copy(finals, s.finals)
	s.mu.Unlock()

	transcript := BuildTranscript(finals)

	// Persist transcript + (later) summary.
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
			// Persist what we have; surface the summarization error.
			_ = meeting.WriteSummary("(резюме не сгенерировано: " + err.Error() + ")")
			return "", err
		}
		if err := meeting.WriteSummary(summaryText); err != nil {
			return summaryText, err
		}
	}

	return summaryText, nil
}

// BuildTranscript renders finals into a readable, speaker-labelled transcript.
func BuildTranscript(finals []v1.Update) string {
	var b []byte
	for _, u := range finals {
		speaker := "Они"
		if u.Channel == v1.ChannelMic {
			speaker = "Я"
		}
		b = append(b, speaker...)
		b = append(b, ": "...)
		b = append(b, u.Text...)
		b = append(b, '\n')
	}
	return string(b)
}
