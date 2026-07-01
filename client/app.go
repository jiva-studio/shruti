package main

import (
	"context"
	"log"

	"github.com/jiva-studio/shruti/client/internal/domain"
	"github.com/jiva-studio/shruti/client/internal/port"
	wailsruntime "github.com/wailsapp/wails/v2/pkg/runtime"
)

// EventUpdate is the frontend event name carrying live transcription updates.
const EventUpdate = "shruti:update"

// App is the Wails driving adapter: it binds ListAudioDevices / StartRecording /
// StopRecording to the Vue frontend and delegates to the application core
// (port.RecordingService), translating between UI values and domain types.
type App struct {
	ctx     context.Context
	service port.RecordingService
}

// NewApp constructs the App over a recording service.
func NewApp(service port.RecordingService) *App { return &App{service: service} }

// startup captures the Wails runtime context (used for event emission).
func (a *App) startup(ctx context.Context) { a.ctx = ctx }

// ListAudioDevices returns the selectable capture endpoints for the UI.
func (a *App) ListAudioDevices() []domain.Device {
	devs, err := a.service.Devices(context.Background())
	if err != nil {
		log.Printf("ListAudioDevices: %v", err)
		return []domain.Device{}
	}
	return devs
}

// uiUpdate is the frontend event payload. Field names are the stable UI contract
// consumed by App.vue — do not rename without updating the frontend.
type uiUpdate struct {
	Type    string `json:"type"` // "partial" | "final"
	Channel int    `json:"channel"`
	Speaker string `json:"speaker,omitempty"`
	Text    string `json:"text"`
	TsMs    int64  `json:"ts_ms"`
}

// StartRecording begins a meeting. providerName selects the engine ("" =
// default); systemDevice/micDevice are chosen PipeWire object.serials ("" to
// omit that source); lang is the ASR language ("" = default). It builds an
// N-source request (here mic + system); more sources would just be appended.
// Returns an error string (empty on success).
func (a *App) StartRecording(providerName, systemDevice, micDevice, lang string) string {
	if lang == "" {
		lang = string(domain.DefaultLanguage)
	}
	var sources []domain.Source
	// Mic first (channel 0) so its fixed "Я" label lands on interleave channel 0.
	if micDevice != "" {
		sources = append(sources, domain.Source{
			Target: micDevice, Name: micDevice, Origin: domain.OriginMic, Speaker: "Я",
		})
	}
	if systemDevice != "" {
		sources = append(sources, domain.Source{
			Target: systemDevice, Name: systemDevice, Origin: domain.OriginSystem,
		})
	}

	emit := func(ev domain.TranscriptEvent) {
		if a.ctx == nil {
			return
		}
		wailsruntime.EventsEmit(a.ctx, EventUpdate, uiUpdate{
			Type: string(ev.Kind), Channel: ev.Channel, Speaker: ev.Speaker, Text: ev.Text, TsMs: ev.TsMs,
		})
	}

	err := a.service.Start(context.Background(), port.StartRequest{
		Provider:  domain.ProviderID(providerName),
		Languages: []domain.Language{domain.Language(lang)},
		Sources:   sources,
	}, emit)
	if err != nil {
		log.Printf("StartRecording: %v", err)
		return err.Error()
	}
	return ""
}

// StopRecording ends the meeting and returns the generated summary (or an error
// prefixed with "ERROR: ").
func (a *App) StopRecording() string {
	sum, err := a.service.Stop(context.Background())
	if err != nil {
		log.Printf("StopRecording: %v", err)
		return "ERROR: " + err.Error()
	}
	return sum.Text
}
