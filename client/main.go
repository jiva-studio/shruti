// Command shruti is the Linux client for the Shruti meeting recorder: a Wails v2
// desktop app that captures system + microphone audio, streams it to a
// transcription engine for live speaker-attributed transcription, and produces
// a summary. main is the composition root: it wires the adapters into the
// application core and runs the UI.
package main

import (
	"embed"
	"log"
	"os"
	"time"

	"github.com/jiva-studio/shruti/client/internal/adapter/audio/pipewire"
	"github.com/jiva-studio/shruti/client/internal/adapter/persistence/sqlite"
	"github.com/jiva-studio/shruti/client/internal/adapter/summary/anthropic"
	"github.com/jiva-studio/shruti/client/internal/adapter/transcriber"
	"github.com/jiva-studio/shruti/client/internal/adapter/transcriber/deepgram"
	"github.com/jiva-studio/shruti/client/internal/adapter/transcriber/parakeet"
	"github.com/jiva-studio/shruti/client/internal/app"
	"github.com/jiva-studio/shruti/client/internal/domain"
	"github.com/jiva-studio/shruti/client/internal/port"
	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

func init() {
	// WebKit2GTK renders with a broken/negative viewport (tiny UI) on Wayland
	// tiling compositors (e.g. niri). Force the X11 backend, which scales
	// correctly through XWayland. Same fix as grammoria's content-manager.
	if os.Getenv("GDK_BACKEND") == "" {
		os.Setenv("GDK_BACKEND", "x11")
	}
}

// systemClock is the real wall clock.
type systemClock struct{}

func (systemClock) Now() time.Time { return time.Now() }

func main() {
	// --- driven adapters ---
	repo, err := sqlite.Open("")
	if err != nil {
		log.Fatalf("open meetings db: %v", err)
	}
	defer repo.Close()

	registry := transcriber.NewRegistry()
	registry.Register(parakeet.ID, parakeet.New)
	registry.Register(deepgram.ID, deepgram.New)
	registry.SetDefault(parakeet.ID)

	// --- application core ---
	service := app.NewService(app.Deps{
		Audio:        pipewire.New(),
		Transcribers: registry,
		Summarizer:   anthropic.New(),
		Repo:         repo,
		Clock:        systemClock{},
		NewID:        newMeetingID,
	})

	// --- driving adapter (UI) ---
	application := NewApp(service)
	if err := wails.Run(&options.App{
		Title:  "Shruti",
		Width:  1400,
		Height: 900,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 20, G: 20, B: 24, A: 1},
		OnStartup:        application.startup,
		Bind:             []interface{}{application},
	}); err != nil {
		log.Fatal(err)
	}
}

// newMeetingID derives a sortable, human-readable meeting id from the clock.
func newMeetingID() domain.MeetingID {
	return domain.MeetingID(time.Now().UTC().Format("20060102-150405.000"))
}

// compile-time checks that the wiring satisfies the ports.
var (
	_ port.RecordingService = (*app.Service)(nil)
)
