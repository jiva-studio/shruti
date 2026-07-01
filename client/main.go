// Command shruti is the Linux client for the Shruti meeting recorder: a Wails v2
// desktop app that captures system + microphone audio, streams it to the Mac
// host for live transcription, and produces a summary.
package main

import (
	"embed"
	"log"
	"os"

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

func main() {
	app := NewApp()

	err := wails.Run(&options.App{
		Title:  "Shruti",
		Width:  1400,
		Height: 900,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 20, G: 20, B: 24, A: 1},
		OnStartup:        app.startup,
		Bind: []interface{}{
			app,
		},
	})
	if err != nil {
		log.Fatal(err)
	}
}
