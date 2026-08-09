// Shruti discovery — an index of lecture audio published on external
// archives.
//
// It fetches a page, flattens it to text, collects every media URL in it, and
// hands each one plus the text around it to a model that says what the
// recording is. Nothing about any particular site lives in this binary: a
// source is a seed URL.
//
// It does not mirror audio and it does not transcribe. Handing a discovered
// media URL to the existing ingest pipeline is a separate, deliberate act.
//
// Subcommands:
//
//	discovery serve         — start the HTTP server (default)
//	discovery migrate       — apply embedded migrations once, then exit
//	discovery healthz       — self-call /healthz over localhost; exit 0/1
//	discovery parse <url>   — fetch one URL, print what came out, write nothing
//	                          (no credentials: use POST /discovery/parse for those)
//	discovery refold-authors — fill in the folded spelling of every stored name,
//	so a speaker can be found however their name was written.
//
//	discovery read-refs [--apply] — read the scripture citations out of the
//	titles we already hold. Prints what it would do; writes only with --apply.
//
//	discovery relink-authors — attach stored recordings to the person they name,
//	                          for when a fix to how names are read cannot reach
//	                          what was already written. Fetches nothing.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/jiva-studio/shruti/discovery/internal/config"
	"github.com/jiva-studio/shruti/discovery/internal/infra/fetch"
	logpkg "github.com/jiva-studio/shruti/discovery/internal/logging"
	"github.com/jiva-studio/shruti/discovery/internal/store"
	"github.com/jiva-studio/shruti/discovery/internal/wire"
)

func main() {
	cmd := "serve"
	if len(os.Args) > 1 {
		cmd = os.Args[1]
	}

	switch cmd {
	case "healthz":
		os.Exit(selfHealthz())
	case "migrate":
		os.Exit(runMigrate())
	case "parse":
		os.Exit(runParse(os.Args[2:]))
	case "recompute":
		os.Exit(runRecompute(os.Args[2:]))
	case "serve":
		runServe()
	default:
		slog.Error("unknown subcommand", "cmd", cmd)
		os.Exit(2)
	}
}

// runParse fetches one URL and prints the three layers. It touches no database
// and writes nothing, so it works anywhere the network does.
func runParse(args []string) int {
	if len(args) == 0 {
		slog.Error("usage: discovery parse <url>")
		return 2
	}
	cfg := config.Load()
	logpkg.SetupTo(os.Stderr, "shruti-discovery", cfg.Env, cfg.ServiceVersion)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	// No database here, so no source and no credentials with it. For a page
	// behind an account, POST /discovery/parse with a "source" instead.
	parser, err := wire.BuildParse(ctx, cfg)
	if err != nil {
		slog.ErrorContext(ctx, "parse_failed", "err", err.Error())
		return 1
	}
	layers, err := parser.URL(ctx, args[0], fetch.Request{})
	if err != nil {
		slog.ErrorContext(ctx, "parse_failed", "url", args[0], "err", err.Error())
		return 1
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(layers); err != nil {
		return 1
	}
	return 0
}

func runMigrate() int {
	cfg := config.Load()
	if err := cfg.RequireDatabase(); err != nil {
		slog.Error("config load failed", "err", err)
		return 2
	}
	logpkg.Setup("shruti-discovery", cfg.Env, cfg.ServiceVersion)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool, err := store.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		slog.ErrorContext(ctx, "db_connect_failed", "err", err.Error())
		return 1
	}
	defer pool.Close()

	if err := store.Migrate(ctx, pool); err != nil {
		slog.ErrorContext(ctx, "migrate_failed", "err", err.Error())
		return 1
	}
	slog.InfoContext(ctx, "migrate_done")
	return 0
}

// drainTimeout is how long shutdown waits for work in hand to finish before it
// starts cutting. It has to fit inside the container's stop grace period, or
// the orchestrator kills the process mid-drain and the wait bought nothing.
const drainTimeout = 20 * time.Second

// waitFor waits on a WaitGroup with a deadline, and reports whether it got
// there. sync.WaitGroup has no such thing, and an unbounded Wait in a shutdown
// path is how a container hangs until it is killed.
func waitFor(wg *sync.WaitGroup, within time.Duration) bool {
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
		return true
	case <-time.After(within):
		return false
	}
}

// runServe starts the HTTP server. Starting the service crawls nothing: the
// scheduler is off unless switched on, and even then it only walks sources that
// are themselves enabled.
func runServe() {
	cfg := config.Load()
	if err := cfg.RequireDatabase(); err != nil {
		slog.Error("config load failed", "err", err)
		os.Exit(2)
	}
	logpkg.Setup("shruti-discovery", cfg.Env, cfg.ServiceVersion)

	bootCtx, bootCancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer bootCancel()

	deps, err := wire.Build(bootCtx, cfg)
	if err != nil {
		slog.ErrorContext(bootCtx, "wire_build_failed", "err", err.Error())
		os.Exit(1)
	}
	defer deps.Pool.Close()
	// Released before the pool it borrows a connection from.
	defer deps.Leader.Release()

	// The background work runs under a context that is not cancelled by
	// shutdown. Shutting down asks it to stop taking new pages; cancelling this
	// is the last resort below, and it is what cuts a page in half.
	workerCtx, workerCancel := context.WithCancel(context.Background())
	defer workerCancel()
	var workers sync.WaitGroup
	if deps.Scheduler != nil {
		workers.Add(1)
		go func() {
			defer workers.Done()
			deps.Scheduler.Run(workerCtx)
		}()
	}

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           deps.Handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		slog.Info("server_listening", "port", cfg.Port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server_error", "err", err.Error())
			os.Exit(1)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	slog.Info("shutdown_start")

	// Stop taking work, then give what is already in hand time to land. One
	// budget covers both the scheduler and the hand-started runs, so the whole
	// drain stays inside the grace period the container is given.
	deadline := time.Now().Add(drainTimeout)
	if deps.Scheduler != nil {
		deps.Scheduler.Stop()
	}
	// Runs started by hand outlive the request that asked for them, so they are
	// stopped and waited for here rather than abandoned mid-write.
	deps.Background.Shutdown(time.Until(deadline))

	if !waitFor(&workers, time.Until(deadline)) {
		// The drain has run out of time. Cancelling now may cut a page in half,
		// which is worse than a clean stop and better than being killed
		// outright — and it is bounded, which an unqualified Wait is not.
		slog.Warn("shutdown_drain_timeout", "waited", drainTimeout.String())
		workerCancel()
		workers.Wait()
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		slog.Error("shutdown_error", "err", err.Error())
		os.Exit(1)
	}
	slog.Info("shutdown_done")
}

// selfHealthz hits /healthz on localhost — the Docker HEALTHCHECK probe for the
// FROM-scratch image, which has no shell.
func selfHealthz() int {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8089"
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/healthz")
	if err != nil {
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

// runRecompute redoes one stage over what is already stored.
//
// A correction in Go reaches nothing already written: a recording is settled
// when its page is read, and a page is read again only when the site, the
// prompt or the script changed. This is how a fix travels, and it is one place
// rather than a subcommand per repair.
//
// Nothing is written without --apply.
func runRecompute(args []string) int {
	fs := flag.NewFlagSet("recompute", flag.ContinueOnError)
	stage := fs.String("stage", "", "author-keys | authors | chunks | pages | normalize")
	source := fs.String("source", "", "limit to one source id")
	apply := fs.Bool("apply", false, "write; without it nothing is changed")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	cfg := config.Load()
	if err := cfg.RequireDatabase(); err != nil {
		slog.Error("config load failed", "err", err)
		return 2
	}
	logpkg.Setup("shruti-discovery", cfg.Env, cfg.ServiceVersion)

	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Hour)
	defer cancel()
	pool, err := store.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		slog.ErrorContext(ctx, "db_connect_failed", "err", err.Error())
		return 1
	}
	defer pool.Close()
	repo := store.NewRepo(pool)

	if !*apply {
		slog.InfoContext(ctx, "recompute_dry_run", "stage", *stage, "source", *source,
			"note", "nothing written; pass --apply")
		return 0
	}

	var done int64
	switch *stage {
	case "author-keys":
		n, err := repo.RefoldAuthorKeys(ctx)
		done = int64(n)
		if err != nil {
			slog.ErrorContext(ctx, "recompute_failed", "stage", *stage, "err", err.Error())
			return 1
		}
	case "authors":
		n, err := repo.RelinkAuthors(ctx, 500)
		done = int64(n)
		if err != nil {
			slog.ErrorContext(ctx, "recompute_failed", "stage", *stage, "err", err.Error())
			return 1
		}
	case "chunks":
		n, err := wire.Rechunker(ctx, cfg, pool).Rechunk(ctx, *source, 200)
		done = int64(n)
		if err != nil {
			slog.ErrorContext(ctx, "recompute_failed", "stage", *stage, "err", err.Error())
			return 1
		}
	case "pages":
		if done, err = repo.ClearScriptVersion(ctx, *source); err != nil {
			slog.ErrorContext(ctx, "recompute_failed", "stage", *stage, "err", err.Error())
			return 1
		}
	case "normalize":
		if done, err = repo.ClearNormHashes(ctx, *source); err != nil {
			slog.ErrorContext(ctx, "recompute_failed", "stage", *stage, "err", err.Error())
			return 1
		}
	default:
		slog.Error("unknown stage", "stage", *stage,
			"known", "author-keys, authors, chunks, pages, normalize")
		return 2
	}
	slog.InfoContext(ctx, "recompute_done", "stage", *stage, "source", *source, "rows", done)
	return 0
}
