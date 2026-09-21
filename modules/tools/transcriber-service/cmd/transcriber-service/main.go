// Command transcriber runs the HTTP service that fronts a long-running
// fluidbatchd subprocess. See the project README for usage.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/jiva-studio/shruti/modules/tools/transcriber-service/internal/server"
	"github.com/jiva-studio/shruti/modules/tools/transcriber-service/internal/store"
	"github.com/jiva-studio/shruti/modules/tools/transcriber-service/internal/worker"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	addr := flag.String("addr", "0.0.0.0:8080", "HTTP listen address")
	dataDir := flag.String("data-dir", defaultDataDir(), "directory for jobs.db, audio/, transcripts/")
	fluidbatchd := flag.String("fluidbatchd", "", "path to fluidbatchd binary (default: ./fluidbatchd/.build/release/fluidbatchd or PATH)")
	workers := flag.Int("workers", 2, "concurrent transcribe workers (sweet spot for M-series ANE is 2)")
	defaultLanguage := flag.String("default-language", "ru", "language code passed to fluidbatchd (empty = auto)")
	maxUpload := flag.Int64("max-upload-bytes", 1<<30, "max bytes per upload (default 1 GB)")
	flag.Parse()

	if err := os.MkdirAll(filepath.Join(*dataDir, "audio"), 0o755); err != nil {
		return fmt.Errorf("mkdir audio: %w", err)
	}
	if err := os.MkdirAll(filepath.Join(*dataDir, "transcripts"), 0o755); err != nil {
		return fmt.Errorf("mkdir transcripts: %w", err)
	}

	binPath, err := resolveFluidbatchd(*fluidbatchd)
	if err != nil {
		return fmt.Errorf("locate fluidbatchd: %w (use -fluidbatchd FLAG or build with `make build`)", err)
	}
	log.Printf("using fluidbatchd at %s", binPath)

	rootCtx, cancelCtx := context.WithCancel(context.Background())
	defer cancelCtx()

	st, err := store.Open(rootCtx, filepath.Join(*dataDir, "jobs.db"))
	if err != nil {
		return fmt.Errorf("open store: %w", err)
	}
	defer st.Close()

	w, err := worker.Start(rootCtx, worker.Config{
		Binary:          binPath,
		Workers:         *workers,
		DefaultLanguage: *defaultLanguage,
		AudioDir:        filepath.Join(*dataDir, "audio"),
		TranscriptsDir:  filepath.Join(*dataDir, "transcripts"),
		Store:           st,
	})
	if err != nil {
		return fmt.Errorf("start worker: %w", err)
	}

	srv := server.New(server.Config{
		Addr:            *addr,
		AudioDir:        filepath.Join(*dataDir, "audio"),
		TranscriptsDir:  filepath.Join(*dataDir, "transcripts"),
		DefaultLanguage: *defaultLanguage,
		Workers:         *workers,
		MaxUploadBytes:  *maxUpload,
		Store:           st,
		Worker:          w,
		StartedAt:       time.Now(),
	})
	httpServer := &http.Server{
		Addr:              *addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 30 * time.Second,
	}

	// Graceful shutdown: SIGINT/SIGTERM closes HTTP, then drains fluidbatchd stdin.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	drained := make(chan struct{})
	go func() {
		defer close(drained)
		<-sigCh
		log.Printf("shutdown: stopping HTTP server")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			log.Printf("http shutdown: %v", err)
		}
		log.Printf("shutdown: stopping fluidbatchd")
		if err := w.Stop(); err != nil {
			log.Printf("worker stop: %v", err)
		}
		cancelCtx()
	}()

	log.Printf("transcriber listening on %s (data=%s, workers=%d)", *addr, *dataDir, *workers)
	err = httpServer.ListenAndServe()
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("listen: %w", err)
	}
	// `Shutdown` returns as soon as HTTP is closed, so this returns while the
	// goroutine is still draining fluidbatchd. Wait for it: the deferred
	// `st.Close()` and `cancelCtx()` would otherwise pull the database and the
	// context out from under a transcription that is still finishing, and the
	// row stays `running` to be transcribed all over again on the next boot.
	<-drained
	log.Printf("transcriber stopped cleanly")
	return nil
}

func defaultDataDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ".transcriber"
	}
	return filepath.Join(home, ".transcriber")
}

func resolveFluidbatchd(flagValue string) (string, error) {
	if flagValue != "" {
		if _, err := os.Stat(flagValue); err != nil {
			return "", err
		}
		abs, err := filepath.Abs(flagValue)
		if err != nil {
			return "", err
		}
		return abs, nil
	}
	// 1. ./fluidbatchd/.build/release/fluidbatchd relative to CWD
	if p, err := filepath.Abs("fluidbatchd/.build/release/fluidbatchd"); err == nil {
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
	}
	// 2. relative to executable dir
	if exe, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exe)
		candidates := []string{
			filepath.Join(exeDir, "fluidbatchd"),
			filepath.Join(exeDir, "..", "fluidbatchd", ".build", "release", "fluidbatchd"),
		}
		for _, c := range candidates {
			if _, err := os.Stat(c); err == nil {
				return filepath.Abs(c)
			}
		}
	}
	// 3. PATH
	if p, err := exec.LookPath("fluidbatchd"); err == nil {
		return p, nil
	}
	return "", os.ErrNotExist
}
