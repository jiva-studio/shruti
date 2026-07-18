package transcript

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// client posts audio to an OpenAI-compatible /audio/transcriptions
// endpoint (OpenRouter by default) with word-level timestamp granularity.
// OpenRouter mirrors the OpenAI multipart contract exactly, so the same
// request shape works against either upstream — only the base URL, model
// and key differ.
type client struct {
	apiKey   string
	endpoint string
	model    string
	httpc    *http.Client
}

func newClient(c Config) *client {
	base := strings.TrimRight(strings.TrimSpace(c.BaseURL), "/")
	return &client{
		apiKey:   c.APIKey,
		endpoint: base + "/audio/transcriptions",
		model:    c.Model,
		httpc: &http.Client{
			Timeout: 5 * time.Minute, // big-enough cap for 120s clips
		},
	}
}

type respWord struct {
	Word  string  `json:"word"`
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

type transcriptionResponse struct {
	Text  string     `json:"text"`
	Words []respWord `json:"words"`
}

// Transcribe uploads the audio as multipart/form-data and asks for
// verbose_json + word granularity.
//
// Form fields (identical across OpenAI and OpenRouter):
//   - "file": the audio file
//   - "model": e.g. "openai/whisper-large-v3"
//   - "response_format": "verbose_json"
//   - "timestamp_granularities[]": "word" — the bracketed name is part of
//     the API contract; both openai-node and the OpenAI cookbook send it
//     exactly like this.
//   - "language": ISO-639-1 code, optional
func (c *client) Transcribe(ctx context.Context, audioPath string, opts Options) (Result, error) {
	f, err := os.Open(audioPath)
	if err != nil {
		return Result{}, fmt.Errorf("open %s: %w", audioPath, err)
	}
	defer f.Close()

	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fileWriter, err := mw.CreateFormFile("file", filepath.Base(audioPath))
	if err != nil {
		return Result{}, fmt.Errorf("multipart file part: %w", err)
	}
	if _, err := io.Copy(fileWriter, f); err != nil {
		return Result{}, fmt.Errorf("copy audio: %w", err)
	}
	for _, kv := range [][2]string{
		{"model", c.model},
		{"response_format", "verbose_json"},
		{"timestamp_granularities[]", "word"},
	} {
		if err := mw.WriteField(kv[0], kv[1]); err != nil {
			return Result{}, fmt.Errorf("multipart field %s: %w", kv[0], err)
		}
	}
	if strings.TrimSpace(opts.Language) != "" {
		if err := mw.WriteField("language", opts.Language); err != nil {
			return Result{}, fmt.Errorf("multipart field language: %w", err)
		}
	}
	if err := mw.Close(); err != nil {
		return Result{}, fmt.Errorf("multipart close: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, &buf)
	if err != nil {
		return Result{}, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Content-Type", mw.FormDataContentType())

	resp, err := c.httpc.Do(req)
	if err != nil {
		return Result{}, fmt.Errorf("transcription request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return Result{}, fmt.Errorf("read response: %w", err)
	}
	if resp.StatusCode/100 != 2 {
		return Result{}, fmt.Errorf("transcription http %d: %s", resp.StatusCode, truncate(body, 400))
	}

	var out transcriptionResponse
	if err := json.Unmarshal(body, &out); err != nil {
		return Result{}, fmt.Errorf("decode response: %w", err)
	}
	words := make([]Word, 0, len(out.Words))
	for _, wd := range out.Words {
		words = append(words, Word{
			Word:  strings.TrimSpace(wd.Word),
			Start: wd.Start,
			End:   wd.End,
		})
	}
	return Result{Text: out.Text, Words: words}, nil
}

func truncate(b []byte, n int) string {
	if len(b) <= n {
		return string(b)
	}
	return string(b[:n]) + "…"
}
