package main

import (
	"context"
	"log"
	"sync"

	"github.com/jiva-studio/shruti/client/internal/capture"
	"github.com/jiva-studio/shruti/client/internal/session"
	"github.com/jiva-studio/shruti/client/internal/summary"
	v1 "github.com/jiva-studio/shruti/proto/v1"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// EventUpdate is the frontend event name carrying live transcription updates.
const EventUpdate = "shruti:update"

// App is the Wails application backend. It exposes StartRecording /
// StopRecording to the Vue frontend and pushes live v1.Update events.
type App struct {
	ctx context.Context

	mu      sync.Mutex
	session *session.Session
}

// NewApp constructs the App.
func NewApp() *App { return &App{} }

// startup captures the Wails runtime context (used for event emission).
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// ListAudioDevices returns the selectable sinks (system output) and sources
// (microphones) for the UI dropdowns.
func (a *App) ListAudioDevices() []capture.Device {
	devs, err := capture.ListDevices(context.Background())
	if err != nil {
		log.Printf("ListAudioDevices: %v", err)
		return []capture.Device{}
	}
	return devs
}

// StartRecording begins a meeting: capture + transcription, streaming updates to
// the frontend via the "shruti:update" event. providerName selects the engine
// ("parakeet" = local Mac host, "deepgram" = cloud; "" = parakeet).
// systemDevice/micDevice are chosen PipeWire node ids ("" = auto-detect); lang is
// the ASR language ("" = "ru"). Returns an error string (empty on success).
func (a *App) StartRecording(providerName, systemDevice, micDevice, lang string) string {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.session != nil {
		return "recording already in progress"
	}
	if lang == "" {
		lang = "ru"
	}

	emit := func(up v1.Update) {
		if a.ctx != nil {
			wailsruntime.EventsEmit(a.ctx, EventUpdate, up)
		}
	}

	sess, err := session.Start(a.ctx, session.Config{
		Provider:     providerName,
		Lang:         lang,
		SystemDevice: systemDevice,
		MicDevice:    micDevice,
	}, summary.NewClaude(), emit)
	if err != nil {
		log.Printf("StartRecording: %v", err)
		return err.Error()
	}
	a.session = sess
	return ""
}

// StopRecording ends the meeting and returns the generated summary (or, on
// failure, a human-readable error prefixed with "ERROR: ").
func (a *App) StopRecording() string {
	a.mu.Lock()
	sess := a.session
	a.session = nil
	a.mu.Unlock()

	if sess == nil {
		return ""
	}
	summaryText, err := sess.Stop(context.Background())
	if err != nil {
		log.Printf("StopRecording: %v", err)
		return "ERROR: " + err.Error()
	}
	return summaryText
}
