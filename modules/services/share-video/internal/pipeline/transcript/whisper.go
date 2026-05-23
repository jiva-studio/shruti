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

const whisperEndpoint = "https://api.openai.com/v1/audio/transcriptions"

type whisper struct {
	apiKey string
	httpc  *http.Client
}

func newWhisper(apiKey string) *whisper {
	return &whisper{
		apiKey: apiKey,
		httpc: &http.Client{
			Timeout: 5 * time.Minute, // big-enough cap for 120s clips
		},
	}
}

type whisperWord struct {
	Word  string  `json:"word"`
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

type whisperResponse struct {
	Text  string        `json:"text"`
	Words []whisperWord `json:"words"`
}

// Transcribe posts the audio file via multipart/form-data to the
// audio.transcriptions endpoint with verbose_json + word granularity.
//
// Form field naming notes:
//   - "file": the audio file
//   - "model": "whisper-1"
//   - "response_format": "verbose_json"
//   - "timestamp_granularities[]": "word" — bracketed name is part of
//     the API contract; both openai-node and the OpenAI cookbook
//     examples send it exactly like that.
//   - "language": ISO-639-1 code, optional
func (w *whisper) Transcribe(ctx context.Context, audioPath string, opts Options) (Result, error) {
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
		{"model", "whisper-1"},
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

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, whisperEndpoint, &buf)
	if err != nil {
		return Result{}, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+w.apiKey)
	req.Header.Set("Content-Type", mw.FormDataContentType())

	resp, err := w.httpc.Do(req)
	if err != nil {
		return Result{}, fmt.Errorf("whisper request: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return Result{}, fmt.Errorf("read response: %w", err)
	}
	if resp.StatusCode/100 != 2 {
		return Result{}, fmt.Errorf("whisper http %d: %s", resp.StatusCode, truncate(body, 400))
	}

	var out whisperResponse
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
