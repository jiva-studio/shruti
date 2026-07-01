// Package engine manages a single fluidstreamd child process: one process per
// audio channel (one per WebSocket connection). It owns the child's pipes and
// exposes them as a byte sink (live PCM → stdin) and an Update source (stdout
// NDJSON → v1.Update). It knows nothing about WebSockets; ./internal/ws wires
// it to a connection.
package engine

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os/exec"

	v1 "github.com/jiva-studio/shruti/proto/v1"
)

// Child is a running fluidstreamd process. The zero value is not usable; obtain
// one from Spawn.
type Child struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser
}

// Spawn starts `fluidPath --lang <lang>` bound to ctx. Cancelling ctx (or
// calling Kill) terminates the process. stdin/stdout are wired to pipes; stderr
// is drained to the standard logger. The models load once at process start
// (~1–2 s, amortized over a meeting), so callers should keep a Child alive for
// the whole connection.
func Spawn(ctx context.Context, fluidPath, lang string) (*Child, error) {
	cmd := exec.CommandContext(ctx, fluidPath, "--lang", lang)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("engine: stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("engine: stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("engine: stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("engine: start %q: %w", fluidPath, err)
	}

	// Drain child stderr into our logs. Ends when the pipe closes (child exit),
	// so no goroutine leak.
	go logLines(stderr, fluidPath)

	return &Child{cmd: cmd, stdin: stdin, stdout: stdout}, nil
}

// Write feeds live PCM bytes to the child's stdin. Safe to call from one
// goroutine only.
func (c *Child) Write(p []byte) (int, error) { return c.stdin.Write(p) }

// CloseStdin closes the child's stdin, signalling EOF. fluidstreamd flushes the
// tail, emits a last "final", and exits 0.
func (c *Child) CloseStdin() error { return c.stdin.Close() }

// Emit scans the child's stdout NDJSON and calls fn once per Update, until the
// stream ends (child exit / EOF) or fn returns an error. Malformed lines are
// logged and skipped. It returns the scanner error (nil on clean EOF) or the
// error from fn.
func (c *Child) Emit(fn func(v1.Update) error) error {
	sc := bufio.NewScanner(c.stdout)
	// Allow long lines (a big final segment) — default 64 KiB is generous but
	// bump the cap to 1 MiB to be safe.
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var u v1.Update
		if err := json.Unmarshal(line, &u); err != nil {
			log.Printf("engine: bad NDJSON from child: %v (line=%q)", err, line)
			continue
		}
		if err := fn(u); err != nil {
			return err
		}
	}
	return sc.Err()
}

// Wait reaps the child. Call only after Emit has returned (all stdout consumed),
// per os/exec's StdoutPipe contract.
func (c *Child) Wait() error { return c.cmd.Wait() }

// Kill terminates the child if it is still running. Idempotent and safe to call
// after the process has exited.
func (c *Child) Kill() {
	if c.cmd.Process != nil {
		_ = c.cmd.Process.Kill()
	}
}

func logLines(r io.Reader, name string) {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		log.Printf("%s: %s", name, sc.Text())
	}
}
