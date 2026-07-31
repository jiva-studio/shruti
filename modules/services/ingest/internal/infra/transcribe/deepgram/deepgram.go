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

	"github.com/jiva-studio/shruti/pipeline/transcript"
)

const listenURL = "https://api.deepgram.com/v1/listen"

// Transcriber calls Deepgram. Provider/Model are recorded on the artifact.
type Transcriber struct {
	apiKey string
	model  string
	http   *http.Client
}

// New builds a Transcriber. model defaults to "nova-3" when empty (required for
// language=multi).
func New(apiKey, model string) *Transcriber {
	if model == "" {
		model = "nova-3"
	}
	return &Transcriber{
		apiKey: apiKey,
		model:  model,
		http:   &http.Client{Timeout: 10 * time.Minute},
	}
}

// Transcribe uploads the local audio file and returns the transcript.Raw plus
// the detected language (ISO code, may be ""). The worker sets TrackId and
// windows the segments into the stored reviewed artifact.
func (t *Transcriber) Transcribe(ctx context.Context, audioPath string) (transcript.Raw, string, error) {
	if t.apiKey == "" {
		return transcript.Raw{}, "", fmt.Errorf("deepgram: DEEPGRAM_API_KEY not configured")
	}
	body, err := os.ReadFile(audioPath)
	if err != nil {
		return transcript.Raw{}, "", fmt.Errorf("read audio: %w", err)
	}

	q := url.Values{}
	q.Set("model", t.model)
	q.Set("smart_format", "true")
	q.Set("punctuate", "true")
	q.Set("paragraphs", "true")
	// language=multi (nova-3) transcribes each language in its own script and
	// handles code-switching. detect_language mis-tagged English lectures that
	// carry Sanskrit terms as Hindi and rendered them in Devanagari.
	q.Set("language", "multi")

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, listenURL+"?"+q.Encode(), bytes.NewReader(body))
	if err != nil {
		return transcript.Raw{}, "", err
	}
	req.Header.Set("Authorization", "Token "+t.apiKey)
	req.Header.Set("Content-Type", "application/octet-stream")

	resp, err := t.http.Do(req)
	if err != nil {
		return transcript.Raw{}, "", fmt.Errorf("deepgram request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		var msg bytes.Buffer
		_, _ = msg.ReadFrom(resp.Body)
		return transcript.Raw{}, "", fmt.Errorf("deepgram status %d: %s", resp.StatusCode, msg.String())
	}

	var dg dgResponse
	if err := json.NewDecoder(resp.Body).Decode(&dg); err != nil {
		return transcript.Raw{}, "", fmt.Errorf("decode deepgram response: %w", err)
	}

	raw, lang := t.toRaw(dg)
	return raw, lang, nil
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
	// In multi mode detected_language is empty; tag the track with the language
	// most of its words are in.
	if lang := majorityLanguage(alt.Words); lang != "" {
		raw.Language = lang
	}

	idx := 0
	for _, p := range alt.Paragraphs.Paragraphs {
		for _, s := range p.Sentences {
			raw.Segments = append(raw.Segments, transcript.RawSegment{
				Idx:        idx,
				Start:      secToMs(s.Start),
				End:        secToMs(s.End),
				Text:       s.Text,
				Confidence: avgWordConfidence(alt.Words, s.Start, s.End),
				Language:   rangeLanguage(alt.Words, s.Start, s.End),
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
	return raw, raw.Language
}

// majorityLanguage returns the language most of the words are in (multi mode
// tags each word). It labels the transcript file + the track's filter bucket;
// the transcript content itself keeps every word in its own language. Empty
// when no word carries a language.
func majorityLanguage(words []dgWord) string {
	counts := map[string]int{}
	for _, w := range words {
		if w.Language != "" {
			counts[w.Language]++
		}
	}
	best, bestN := "", 0
	for lang, n := range counts {
		if n > bestN {
			best, bestN = lang, n
		}
	}
	return best
}

// rangeLanguage returns the language most of the words inside [start,end] are
// in — one sentence's language. Drives the per-language transcript split.
func rangeLanguage(words []dgWord, start, end float64) string {
	counts := map[string]int{}
	for _, w := range words {
		if w.Start >= start && w.End <= end && w.Language != "" {
			counts[w.Language]++
		}
	}
	best, bestN := "", 0
	for lang, n := range counts {
		if n > bestN {
			best, bestN = lang, n
		}
	}
	return best
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
	Language   string  `json:"language"` // per-word language in multi mode
}
