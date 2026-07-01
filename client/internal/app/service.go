// Package app is the application core: it orchestrates the driven ports
// (audio, transcriber, summarizer, repository) to run a meeting. It depends only
// on the domain and the port interfaces — never on concrete adapters.
package app

import (
	"context"
	"fmt"
	"log"
	"sync"

	"github.com/jiva-studio/shruti/client/internal/domain"
	"github.com/jiva-studio/shruti/client/internal/port"
)

// Deps are the ports the recording service needs. Injected at composition time.
type Deps struct {
	Audio        port.AudioSource
	Transcribers port.TranscriberFactory
	Summarizer   port.Summarizer
	Repo         port.MeetingRepository
	Clock        port.Clock
	NewID        func() domain.MeetingID
}

// Service implements port.RecordingService.
type Service struct {
	deps Deps

	mu     sync.Mutex
	active *recording
}

// NewService builds the recording service from its dependencies.
func NewService(d Deps) *Service { return &Service{deps: d} }

// recording is one in-flight meeting.
type recording struct {
	capture port.Capture
	stream  port.TranscriptionStream
	meeting *domain.Meeting

	mu     sync.Mutex // guards meeting.Utterances
	pumpWG sync.WaitGroup
	fanWG  sync.WaitGroup
}

// Devices lists selectable capture endpoints.
func (s *Service) Devices(ctx context.Context) ([]domain.Device, error) {
	return s.deps.Audio.Devices(ctx)
}

// Start begins capture + transcription for the requested sources.
func (s *Service) Start(ctx context.Context, req port.StartRequest, emit func(domain.TranscriptEvent)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.active != nil {
		return fmt.Errorf("app: recording already in progress")
	}

	plan := buildPlan(req)
	transcriber, err := s.deps.Transcribers.Transcriber(plan.Provider)
	if err != nil {
		return err
	}

	capture, err := s.deps.Audio.Capture(ctx, plan)
	if err != nil {
		return fmt.Errorf("app: start capture: %w", err)
	}
	for _, src := range capture.Sources() {
		log.Printf("capture source: ch=%d origin=%s target=%s name=%s", src.Channel, src.Origin, src.Target, src.Name)
	}

	stream, err := transcriber.Open(ctx, plan)
	if err != nil {
		capture.Stop()
		return fmt.Errorf("app: open transcriber: %w", err)
	}

	rec := &recording{
		capture: capture,
		stream:  stream,
		meeting: domain.NewMeeting(s.deps.NewID(), s.deps.Clock.Now(), plan),
	}
	rec.pump(ctx, plan, transcriber.Layout())
	rec.fanIn(emit)
	s.active = rec
	return nil
}

// Stop ends the meeting, persists it, summarizes it, and returns the summary.
func (s *Service) Stop(ctx context.Context) (domain.Summary, error) {
	s.mu.Lock()
	rec := s.active
	s.active = nil
	s.mu.Unlock()
	if rec == nil {
		return domain.Summary{}, nil
	}

	// Drain in order: stop capture → let the pump finish writing → close the
	// stream (flushes finals) → let fan-in record them.
	rec.capture.Stop()
	rec.pumpWG.Wait()
	_ = rec.stream.Close()
	rec.fanWG.Wait()

	m := rec.meeting
	m.EndedAt = s.deps.Clock.Now()

	if err := s.deps.Repo.Save(ctx, m); err != nil {
		return domain.Summary{}, fmt.Errorf("app: save meeting: %w", err)
	}

	if s.deps.Summarizer != nil && len(m.Utterances) > 0 {
		sum, err := s.deps.Summarizer.Summarize(ctx, m)
		if err != nil {
			return domain.Summary{}, fmt.Errorf("app: summarize: %w", err)
		}
		m.Summary = &sum
		if err := s.deps.Repo.Save(ctx, m); err != nil {
			return sum, fmt.Errorf("app: save summary: %w", err)
		}
		return sum, nil
	}
	return domain.Summary{}, nil
}

// buildPlan turns a UI request into a capture plan, assigning channel indices in
// source order (channel i == interleave position i).
func buildPlan(req port.StartRequest) domain.CapturePlan {
	sources := make([]domain.Source, len(req.Sources))
	for i, src := range req.Sources {
		src.Channel = i
		sources[i] = src
	}
	return domain.CapturePlan{
		Sources:   sources,
		Provider:  req.Provider,
		Languages: req.Languages,
	}
}

// pump reads one frame from each source channel per tick, packs them per the
// engine layout (mixed mono or interleaved N-channel), and writes to the stream.
func (r *recording) pump(ctx context.Context, plan domain.CapturePlan, layout domain.AudioLayout) {
	chans := make([]<-chan []byte, len(plan.Sources))
	for i, src := range plan.Sources {
		chans[i] = r.capture.Frames(src.Channel)
	}
	r.pumpWG.Add(1)
	go func() {
		defer r.pumpWG.Done()
		var total int64
		for {
			frames := make([][]byte, len(chans))
			anyOpen := false
			for i, ch := range chans {
				if f, ok := <-ch; ok {
					frames[i] = f
					anyOpen = true
				}
			}
			if !anyOpen {
				log.Printf("capture: ended, %d B total", total)
				return
			}
			packed := packFrames(layout, frames)
			total += int64(len(packed))
			if err := r.stream.Write(packed); err != nil {
				log.Printf("capture: write error after %d B: %v", total, err)
				return
			}
			select {
			case <-ctx.Done():
				return
			default:
			}
		}
	}()
}

// packFrames packs one tick of per-source frames for the engine's layout.
func packFrames(layout domain.AudioLayout, frames [][]byte) []byte {
	if layout == domain.LayoutMultiChannel {
		return domain.Interleave(frames...)
	}
	return domain.MixMono(frames...)
}

// fanIn consumes transcription events, records finals on the meeting, and emits
// every event to the UI.
func (r *recording) fanIn(emit func(domain.TranscriptEvent)) {
	r.fanWG.Add(1)
	go func() {
		defer r.fanWG.Done()
		for ev := range r.stream.Events() {
			if ev.Kind == domain.EventFinal {
				r.mu.Lock()
				r.meeting.AppendFinal(ev)
				r.mu.Unlock()
			}
			if emit != nil {
				emit(ev)
			}
		}
	}()
}
