// Package deepgram implements ports.Transcriber against the Deepgram
// pre-recorded HTTP API (POST /v1/listen). It maps the response into a
// pipeline transcript.Raw artifact (one segment per detected sentence, with
// ms offsets and averaged word confidence) and reports the ASR-detected
// language so downstream stages can tag the track.
package deepgram

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"time"

	"github.com/jiva-studio/lectorium/pipeline/transcript"
)

const listenURL = "https://api.deepgram.com/v1/listen"

// Transcriber calls Deepgram. Provider/Model are recorded on the artifact.
type Transcriber struct {
	apiKey string
	model  string
	http   *http.Client
}

// New builds a Transcriber. model defaults to "nova-2" when empty.
func New(apiKey, model string) *Transcriber {
	if model == "" {
		model = "nova-2"
	}
	return &Transcriber{
		apiKey: apiKey,
		model:  model,
		http:   &http.Client{Timeout: 10 * time.Minute},
	}
}

// Transcribe uploads the local audio file and returns the marshalled
// transcript.Raw plus the detected language (ISO code, may be "").
func (t *Transcriber) Transcribe(ctx context.Context, audioPath string) ([]byte, string, error) {
	if t.apiKey == "" {
		return nil, "", fmt.Errorf("deepgram: DEEPGRAM_API_KEY not configured")
	}
	body, err := os.ReadFile(audioPath)
	if err != nil {
		return nil, "", fmt.Errorf("read audio: %w", err)
	}

	q := url.Values{}
	q.Set("model", t.model)
	q.Set("smart_format", "true")
	q.Set("punctuate", "true")
	q.Set("paragraphs", "true")
	q.Set("detect_language", "true")

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, listenURL+"?"+q.Encode(), bytes.NewReader(body))
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Authorization", "Token "+t.apiKey)
	req.Header.Set("Content-Type", "application/octet-stream")

	resp, err := t.http.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("deepgram request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		var msg bytes.Buffer
		_, _ = msg.ReadFrom(resp.Body)
		return nil, "", fmt.Errorf("deepgram status %d: %s", resp.StatusCode, msg.String())
	}

	var dg dgResponse
	if err := json.NewDecoder(resp.Body).Decode(&dg); err != nil {
		return nil, "", fmt.Errorf("decode deepgram response: %w", err)
	}

	raw, lang := t.toRaw(dg)
	out, err := json.Marshal(raw)
	if err != nil {
		return nil, "", err
	}
	return out, lang, nil
}

// toRaw maps the Deepgram response into a transcript.Raw. It prefers the
// sentence structure from smart-formatted paragraphs; if absent it falls back
// to a single segment carrying the whole transcript.
func (t *Transcriber) toRaw(dg dgResponse) (transcript.Raw, string) {
	raw := transcript.Raw{Provider: "deepgram", Model: t.model}
	if len(dg.Results.Channels) == 0 {
		return raw, ""
	}
	ch := dg.Results.Channels[0]
	raw.Language = ch.DetectedLanguage
	if len(ch.Alternatives) == 0 {
		return raw, ch.DetectedLanguage
	}
	alt := ch.Alternatives[0]

	idx := 0
	for _, p := range alt.Paragraphs.Paragraphs {
		for _, s := range p.Sentences {
			raw.Segments = append(raw.Segments, transcript.RawSegment{
				Idx:        idx,
				Start:      secToMs(s.Start),
				End:        secToMs(s.End),
				Text:       s.Text,
				Confidence: avgWordConfidence(alt.Words, s.Start, s.End),
			})
			idx++
		}
	}
	if len(raw.Segments) == 0 && alt.Transcript != "" {
		var end float64
		if len(alt.Words) > 0 {
			end = alt.Words[len(alt.Words)-1].End
		}
		raw.Segments = append(raw.Segments, transcript.RawSegment{
			Idx: 0, Start: 0, End: secToMs(end), Text: alt.Transcript, Confidence: alt.Confidence,
		})
	}
	return raw, ch.DetectedLanguage
}

func secToMs(s float64) int64 { return int64(s * 1000) }

// avgWordConfidence averages the confidence of words that fall inside [start,end].
func avgWordConfidence(words []dgWord, start, end float64) float64 {
	var sum float64
	var n int
	for _, w := range words {
		if w.Start >= start && w.End <= end {
			sum += w.Confidence
			n++
		}
	}
	if n == 0 {
		return 0
	}
	return sum / float64(n)
}

// --- Deepgram response shapes (subset) ---

type dgResponse struct {
	Results struct {
		Channels []struct {
			DetectedLanguage string          `json:"detected_language"`
			Alternatives     []dgAlternative `json:"alternatives"`
		} `json:"channels"`
	} `json:"results"`
}

type dgAlternative struct {
	Transcript string   `json:"transcript"`
	Confidence float64  `json:"confidence"`
	Words      []dgWord `json:"words"`
	Paragraphs struct {
		Paragraphs []struct {
			Sentences []struct {
				Text  string  `json:"text"`
				Start float64 `json:"start"`
				End   float64 `json:"end"`
			} `json:"sentences"`
		} `json:"paragraphs"`
	} `json:"paragraphs"`
}

type dgWord struct {
	Word       string  `json:"word"`
	Start      float64 `json:"start"`
	End        float64 `json:"end"`
	Confidence float64 `json:"confidence"`
}
