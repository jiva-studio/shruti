// Package razdelsplit wraps the razdel Python library as a long-lived
// subprocess driven via JSON-line stdin/stdout. Russian sentence
// segmentation is full of edge cases (abbreviations, initials,
// embedded verses in quotes) that pure punctuation rules miss; razdel
// encodes ~500 hand-tuned rules from the Natasha NLP project and gets
// them right. We pay one Python startup at daemon launch and ~0.1ms
// per Split call thereafter.
//
// The subprocess is restarted automatically if it crashes or its
// stdout pipe closes.
package razdelsplit

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/sentencesplit"
)

type Splitter struct {
	pythonBin  string
	scriptPath string

	mu     sync.Mutex // razdel is single-threaded; serialize requests
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader
	closed bool
}

type Config struct {
	// PythonBin is the interpreter to run; defaults to "python3" when empty.
	PythonBin string
	// ScriptPath is the path to scripts/sentencesplit/razdel.py. Required.
	ScriptPath string
}

func New(cfg Config) (*Splitter, error) {
	if cfg.ScriptPath == "" {
		return nil, fmt.Errorf("razdelsplit: ScriptPath is required")
	}
	if _, err := os.Stat(cfg.ScriptPath); err != nil {
		return nil, fmt.Errorf("razdelsplit: script not found: %w", err)
	}
	bin := cfg.PythonBin
	if bin == "" {
		bin = "python3"
	}
	s := &Splitter{pythonBin: bin, scriptPath: cfg.ScriptPath}
	if err := s.spawn(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Splitter) spawn() error {
	cmd := exec.Command(s.pythonBin, "-u", s.scriptPath)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("razdelsplit: stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("razdelsplit: stdout pipe: %w", err)
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("razdelsplit: start: %w", err)
	}
	s.cmd = cmd
	s.stdin = stdin
	s.stdout = bufio.NewReader(stdout)
	return nil
}

// Split sends one request to the running subprocess and decodes the
// reply. On EOF (subprocess died) it respawns once and retries — this
// covers crashes from malformed input or OS pipe pressure without
// losing the call.
func (s *Splitter) Split(ctx context.Context, text string) ([]sentencesplit.Sentence, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, fmt.Errorf("razdelsplit: splitter closed")
	}

	body, err := json.Marshal(map[string]string{"text": text})
	if err != nil {
		return nil, err
	}
	body = append(body, '\n')

	for attempt := 0; attempt < 2; attempt++ {
		if _, err := s.stdin.Write(body); err != nil {
			if attempt == 0 && s.respawn() == nil {
				continue
			}
			return nil, fmt.Errorf("razdelsplit: write: %w", err)
		}
		line, err := s.stdout.ReadBytes('\n')
		if err != nil {
			if attempt == 0 && s.respawn() == nil {
				continue
			}
			return nil, fmt.Errorf("razdelsplit: read: %w", err)
		}
		var raw struct {
			Sentences []sentencesplit.Sentence
			Err       string
		}
		if err := decodeReply(line, &raw); err != nil {
			return nil, err
		}
		if raw.Err != "" {
			return nil, fmt.Errorf("razdelsplit: %s", raw.Err)
		}
		return raw.Sentences, nil
	}
	return nil, fmt.Errorf("razdelsplit: subprocess respawn failed")
}

// decodeReply handles both shapes scripts/sentencesplit/razdel.py emits:
//   - normal: a JSON array of {start,stop,text}
//   - error: a JSON object {"error": "..."}
func decodeReply(line []byte, out *struct {
	Sentences []sentencesplit.Sentence
	Err       string
}) error {
	if len(line) == 0 {
		return fmt.Errorf("razdelsplit: empty reply")
	}
	first := line[0]
	for _, b := range line {
		if b == ' ' || b == '\t' {
			continue
		}
		first = b
		break
	}
	if first == '[' {
		return json.Unmarshal(line, &out.Sentences)
	}
	var errObj struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(line, &errObj); err != nil {
		return fmt.Errorf("razdelsplit: parse reply: %w (line: %s)", err, string(line))
	}
	out.Err = errObj.Error
	return nil
}

// respawn kills the current subprocess (if still alive) and spawns a
// fresh one. Caller must hold s.mu.
func (s *Splitter) respawn() error {
	if s.cmd != nil && s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
		_ = s.cmd.Wait()
	}
	return s.spawn()
}

func (s *Splitter) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	if s.stdin != nil {
		_ = s.stdin.Close()
	}
	if s.cmd != nil && s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
		_ = s.cmd.Wait()
	}
	return nil
}

var _ sentencesplit.Splitter = (*Splitter)(nil)
