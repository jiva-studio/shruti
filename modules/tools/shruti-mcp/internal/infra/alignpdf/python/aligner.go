// Package pythonalign wraps the pdf_align Python package as a long-lived
// subprocess driven via JSON-line stdin/stdout. We pay one Python startup
// (~300ms: pymupdf + rapidfuzz import) at daemon launch and ~50ms per
// Align call thereafter.
//
// Mirrors the razdel sentencesplit adapter (internal/infra/sentencesplit/razdel)
// — same lifecycle: spawn at New, serialize through a mutex, respawn on
// pipe failure, kill on Close.
package pythonalign

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"

	alignpdfport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/alignpdf"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/transcript"
)

type Aligner struct {
	pythonBin  string
	scriptPath string

	mu     sync.Mutex // pdf_align is single-threaded; serialize requests
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader
	closed bool
}

type Config struct {
	// PythonBin is the interpreter to run; defaults to "python3" when empty.
	PythonBin string
	// ScriptPath is the path to scripts/pdf_align/daemon.py. Required.
	ScriptPath string
}

func New(cfg Config) (*Aligner, error) {
	if cfg.ScriptPath == "" {
		return nil, fmt.Errorf("pythonalign: ScriptPath is required")
	}
	if _, err := os.Stat(cfg.ScriptPath); err != nil {
		return nil, fmt.Errorf("pythonalign: script not found: %w", err)
	}
	bin := cfg.PythonBin
	if bin == "" {
		bin = "python3"
	}
	a := &Aligner{pythonBin: bin, scriptPath: cfg.ScriptPath}
	if err := a.spawn(); err != nil {
		return nil, err
	}
	return a, nil
}

func (a *Aligner) spawn() error {
	cmd := exec.Command(a.pythonBin, "-u", a.scriptPath)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("pythonalign: stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("pythonalign: stdout pipe: %w", err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("pythonalign: start: %w", err)
	}
	a.cmd = cmd
	a.stdin = stdin
	a.stdout = bufio.NewReader(stdout)
	return nil
}

// Align sends one request to the running subprocess and decodes the reply.
// On pipe failure it respawns once and retries — this covers crashes from
// malformed input or OS pipe pressure without losing the call.
func (a *Aligner) Align(ctx context.Context, req alignpdfport.Request) (transcript.Reviewed, error) {
	body, err := json.Marshal(map[string]string{
		"action":   "align",
		"pdf_path": req.PDFPath,
		"raw_path": req.RawPath,
		"language": req.Language,
	})
	if err != nil {
		return transcript.Reviewed{}, err
	}
	line, err := a.exchange(body)
	if err != nil {
		return transcript.Reviewed{}, err
	}
	var rev transcript.Reviewed
	if err := json.Unmarshal(line, &rev); err != nil {
		return transcript.Reviewed{}, fmt.Errorf("pythonalign: parse align reply: %w (line: %s)", err, truncate(line, 200))
	}
	return rev, nil
}

// ExtractTitleHint asks the sidecar for the first bold@16 line on page 1 of
// the PDF. Returns "" when the PDF has no such header.
func (a *Aligner) ExtractTitleHint(ctx context.Context, pdfPath string) (string, error) {
	body, err := json.Marshal(map[string]string{
		"action":   "title_hint",
		"pdf_path": pdfPath,
	})
	if err != nil {
		return "", err
	}
	line, err := a.exchange(body)
	if err != nil {
		return "", err
	}
	var reply struct {
		HeaderHint *string `json:"header_hint"`
	}
	if err := json.Unmarshal(line, &reply); err != nil {
		return "", fmt.Errorf("pythonalign: parse title_hint reply: %w (line: %s)", err, truncate(line, 200))
	}
	if reply.HeaderHint == nil {
		return "", nil
	}
	return *reply.HeaderHint, nil
}

// exchange writes one already-marshaled request line and reads back one
// response line. Handles the {"error": "..."} reply shape uniformly so
// callers only need to JSON-decode the success shape they expect.
// Respawns the subprocess once on pipe failure.
func (a *Aligner) exchange(body []byte) ([]byte, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return nil, fmt.Errorf("pythonalign: aligner closed")
	}
	body = append(body, '\n')
	for attempt := 0; attempt < 2; attempt++ {
		if _, err := a.stdin.Write(body); err != nil {
			if attempt == 0 && a.respawn() == nil {
				continue
			}
			return nil, fmt.Errorf("pythonalign: write: %w", err)
		}
		line, err := a.stdout.ReadBytes('\n')
		if err != nil {
			if attempt == 0 && a.respawn() == nil {
				continue
			}
			return nil, fmt.Errorf("pythonalign: read: %w", err)
		}
		var head struct {
			Error string `json:"error"`
		}
		if err := json.Unmarshal(line, &head); err == nil && head.Error != "" {
			return nil, fmt.Errorf("pythonalign: %s", head.Error)
		}
		return line, nil
	}
	return nil, fmt.Errorf("pythonalign: subprocess respawn failed")
}

// respawn kills the current subprocess (if still alive) and spawns a fresh
// one. Caller must hold a.mu.
func (a *Aligner) respawn() error {
	if a.cmd != nil && a.cmd.Process != nil {
		_ = a.cmd.Process.Kill()
		_ = a.cmd.Wait()
	}
	return a.spawn()
}

func (a *Aligner) Close() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.closed {
		return nil
	}
	a.closed = true
	if a.stdin != nil {
		_ = a.stdin.Close()
	}
	if a.cmd != nil && a.cmd.Process != nil {
		_ = a.cmd.Process.Kill()
		_ = a.cmd.Wait()
	}
	return nil
}

func truncate(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "..."
}

var _ alignpdfport.Aligner = (*Aligner)(nil)
