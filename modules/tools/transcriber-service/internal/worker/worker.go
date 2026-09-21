// Package worker manages the long-running fluidbatchd subprocess and translates
// its stderr lifecycle events into Store updates.
package worker

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/jiva-studio/lectorium/modules/tools/transcriber-service/internal/job"
	"github.com/jiva-studio/lectorium/modules/tools/transcriber-service/internal/store"
)

// Config wires the worker to its environment.
type Config struct {
	Binary          string // path to fluidbatchd
	Workers         int    // --workers passed to fluidbatchd
	DefaultLanguage string // --language default
	AudioDir        string // where MP3s live
	TranscriptsDir  string // --output-dir passed to fluidbatchd
	Store           *store.Store
}

// Worker holds the running fluidbatchd subprocess and accepts new job paths
// over the Submit channel. It must be created with Start.
type Worker struct {
	ctx    context.Context
	cfg    Config
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	submit chan string // job_id values to be transcribed
	closed chan struct{}
	mu     sync.Mutex
	ready  bool
}

// Start launches fluidbatchd, kicks off the feeder + reader goroutines and
// re-queues anything left in 'running' or 'queued' from a previous run.
func Start(ctx context.Context, cfg Config) (*Worker, error) {
	if cfg.Workers <= 0 {
		cfg.Workers = 2
	}
	args := []string{
		"--workers", strconv.Itoa(cfg.Workers),
		"--output-dir", cfg.TranscriptsDir,
	}
	if cfg.DefaultLanguage != "" {
		args = append(args, "--language", cfg.DefaultLanguage)
	}
	cmd := exec.CommandContext(ctx, cfg.Binary, args...)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("stdin pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("stderr pipe: %w", err)
	}
	cmd.Stdout = os.Stdout

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start fluidbatchd: %w", err)
	}

	w := &Worker{
		ctx:    ctx,
		cfg:    cfg,
		cmd:    cmd,
		stdin:  stdin,
		submit: make(chan string, 256),
		closed: make(chan struct{}),
	}

	go w.feeder()
	go w.reader(stderr)

	// Re-queue work that was running when we last shut down. Then re-feed everything queued.
	if n, err := cfg.Store.ResetRunningToQueued(ctx); err != nil {
		log.Printf("worker: reset running→queued failed: %v", err)
	} else if n > 0 {
		log.Printf("worker: requeued %d previously running job(s)", n)
	}
	ids, err := cfg.Store.QueuedJobIDs(ctx)
	if err != nil {
		log.Printf("worker: load queued jobs failed: %v", err)
	}
	for _, id := range ids {
		w.submit <- id
	}

	return w, nil
}

// Submit enqueues a job_id for processing. Non-blocking when the buffer has room;
// blocks only if the buffer is full (256 in-flight uploads is a lot).
func (w *Worker) Submit(jobID string) {
	w.submit <- jobID
}

// ModelLoaded returns true once fluidbatchd has emitted READY.
func (w *Worker) ModelLoaded() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.ready
}

// Stop closes stdin so fluidbatchd drains the queue and exits, then waits.
func (w *Worker) Stop() error {
	_ = w.stdin.Close()
	err := w.cmd.Wait()
	close(w.closed)
	return err
}

// --- internals ---

func (w *Worker) feeder() {
	for jobID := range w.submit {
		path := filepath.Join(w.cfg.AudioDir, jobID+".mp3")
		if _, err := os.Stat(path); err != nil {
			log.Printf("worker: drop %s (missing audio file: %v)", jobID, err)
			_ = w.cfg.Store.MarkFailed(w.ctx, jobID, "audio file missing on disk")
			continue
		}
		// Per-job language: fluidbatchd accepts "<path>\t<lang>" on stdin.
		// Without the suffix the Swift side falls back to the --language
		// startup default, so a Russian-defaulted process would mis-decode
		// English audio. Look up what the HTTP layer recorded and pass it
		// through; fall back to bare path if the row is missing or empty.
		line := path
		if j, err := w.cfg.Store.Get(w.ctx, jobID); err != nil {
			log.Printf("worker: store.Get %s: %v (using default lang)", jobID, err)
		} else if j != nil && j.Language != "" {
			line = path + "\t" + j.Language
		}
		if _, err := fmt.Fprintln(w.stdin, line); err != nil {
			log.Printf("worker: write to fluidbatchd stdin failed: %v", err)
			return
		}
	}
}

func (w *Worker) reader(stderr io.ReadCloser) {
	scanner := bufio.NewScanner(stderr)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case strings.HasPrefix(line, "READY\t"):
			w.mu.Lock()
			w.ready = true
			w.mu.Unlock()
			log.Printf("worker: %s", line)
		case strings.HasPrefix(line, "START\t"):
			w.handleStart(line)
		case strings.HasPrefix(line, "OK\t"):
			w.handleOK(line)
		case strings.HasPrefix(line, "FAIL\t"):
			w.handleFail(line)
		default:
			// fluidbatchd / Swift runtime / FluidAudio diagnostics — pass through to our log.
			log.Printf("fluidbatchd: %s", line)
		}
	}
	if err := scanner.Err(); err != nil {
		log.Printf("worker: stderr reader error: %v", err)
	}
}

func (w *Worker) handleStart(line string) {
	fields := parseTSV(line)
	jobID := fields["job_id"]
	if jobID == "" {
		log.Printf("worker: malformed START: %s", line)
		return
	}
	if err := w.cfg.Store.MarkRunning(w.ctx, jobID); err != nil {
		log.Printf("worker: mark running %s: %v", jobID, err)
	}
}

func (w *Worker) handleOK(line string) {
	fields := parseTSV(line)
	jobID := fields["job_id"]
	if jobID == "" {
		log.Printf("worker: malformed OK: %s", line)
		return
	}
	m := job.Metrics{
		ProcessingTimeSeconds: parseFloat(fields["proc"]),
		DurationSeconds:       parseFloat(fields["dur"]),
		Confidence:            parseFloat(fields["conf"]),
		RTFx:                  parseFloat(fields["rtfx"]),
	}
	if err := w.cfg.Store.MarkDone(w.ctx, jobID, m); err != nil {
		log.Printf("worker: mark done %s: %v", jobID, err)
	}
	// Audio is no longer needed.
	audio := filepath.Join(w.cfg.AudioDir, jobID+".mp3")
	if err := os.Remove(audio); err != nil && !os.IsNotExist(err) {
		log.Printf("worker: remove audio %s: %v", jobID, err)
	}
	log.Printf("worker: done %s (%.2fs, conf=%.2f)", jobID, m.ProcessingTimeSeconds, m.Confidence)
}

func (w *Worker) handleFail(line string) {
	fields := parseTSV(line)
	jobID := fields["job_id"]
	errMsg := unescapeTSV(fields["error"])
	if jobID == "" {
		log.Printf("worker: malformed FAIL: %s", line)
		return
	}
	if err := w.cfg.Store.MarkFailed(w.ctx, jobID, errMsg); err != nil {
		log.Printf("worker: mark failed %s: %v", jobID, err)
	}
	log.Printf("worker: fail %s: %s", jobID, errMsg)
}

func parseTSV(line string) map[string]string {
	out := make(map[string]string, 6)
	parts := strings.Split(line, "\t")
	for _, p := range parts[1:] { // skip the leading tag (READY/OK/FAIL)
		eq := strings.IndexByte(p, '=')
		if eq < 0 {
			continue
		}
		out[p[:eq]] = p[eq+1:]
	}
	return out
}

func parseFloat(s string) float64 {
	if s == "" {
		return 0
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return v
}

func unescapeTSV(s string) string {
	// Reverse of fluidbatchd's tsvEscape: \\ -> \, \t -> tab, \n -> newline.
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+1 < len(s) {
			switch s[i+1] {
			case '\\':
				b.WriteByte('\\')
			case 't':
				b.WriteByte('\t')
			case 'n':
				b.WriteByte('\n')
			default:
				b.WriteByte(s[i+1])
			}
			i++
			continue
		}
		b.WriteByte(s[i])
	}
	return b.String()
}
