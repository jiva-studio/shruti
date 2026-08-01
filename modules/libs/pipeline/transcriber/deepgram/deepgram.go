// Package deepgram implements transcriber.Transcriber against the Deepgram
// pre-recorded API, tagging each segment with its language (multi mode) and,
// with diarize on, its speaker.
package deepgram

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"time"

	"github.com/jiva-studio/lectorium/pipeline/ports/transcriber"
	"github.com/jiva-studio/lectorium/pipeline/transcript"
)

const listenURL = "https://api.deepgram.com/v1/listen"

// Config configures the adapter. Model defaults to nova-3, required by
// language=multi; Language empty means multi; Diarize nil follows multi mode;
// Timeout 0 means 10 minutes.
type Config struct {
	APIKey   string
	Model    string
	Language string
	Diarize  *bool
	Timeout  time.Duration
}

// Transcriber calls Deepgram. Provider/Model are recorded on the artifact.
type Transcriber struct {
	cfg  Config
	http *http.Client
}

// New builds a Transcriber from cfg.
func New(cfg Config) *Transcriber {
	if cfg.Model == "" {
		cfg.Model = "nova-3"
	}
	if cfg.Timeout == 0 {
		cfg.Timeout = 10 * time.Minute
	}
	return &Transcriber{cfg: cfg, http: &http.Client{Timeout: cfg.Timeout}}
}

// Name identifies the provider in the registry and on the artifact.
func (t *Transcriber) Name() string { return "deepgram" }

// Transcribe uploads the audio and returns the raw transcript. opts.Language
// and opts.Model override the configured values.
func (t *Transcriber) Transcribe(ctx context.Context, audioPath string, opts transcriber.Options) (transcript.Raw, error) {
	if t.cfg.APIKey == "" {
		return transcript.Raw{}, fmt.Errorf("deepgram: api key not configured")
	}
	body, err := os.ReadFile(audioPath)
	if err != nil {
		return transcript.Raw{}, fmt.Errorf("read audio: %w", err)
	}

	model := t.cfg.Model
	if opts.Model != "" {
		model = opts.Model
	}
	lang := t.cfg.Language
	if opts.Language != "" {
		lang = opts.Language
	}
	if lang == "" {
		// detect_language mis-tags English lectures carrying Sanskrit as Hindi.
		lang = "multi"
	}

	diarize := lang == "multi"
	if t.cfg.Diarize != nil {
		diarize = *t.cfg.Diarize
	}

	q := url.Values{}
	q.Set("model", model)
	q.Set("smart_format", "true")
	q.Set("punctuate", "true")
	q.Set("paragraphs", "true")
	q.Set("language", lang)
	if diarize {
		q.Set("diarize", "true")
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, listenURL+"?"+q.Encode(), bytes.NewReader(body))
	if err != nil {
		return transcript.Raw{}, err
	}
	req.Header.Set("Authorization", "Token "+t.cfg.APIKey)
	req.Header.Set("Content-Type", "application/octet-stream")

	resp, err := t.http.Do(req)
	if err != nil {
		return transcript.Raw{}, fmt.Errorf("deepgram request: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		var msg bytes.Buffer
		_, _ = msg.ReadFrom(resp.Body)
		return transcript.Raw{}, fmt.Errorf("deepgram status %d: %s", resp.StatusCode, msg.String())
	}

	var dg dgResponse
	if err := json.NewDecoder(resp.Body).Decode(&dg); err != nil {
		return transcript.Raw{}, fmt.Errorf("decode deepgram response: %w", err)
	}
	return t.toRaw(dg, model), nil
}

// toRaw maps the Deepgram response into a transcript.Raw. It prefers the
// sentence structure from smart-formatted paragraphs; if absent it falls back
// to a single segment carrying the whole transcript.
func (t *Transcriber) toRaw(dg dgResponse, model string) transcript.Raw {
	raw := transcript.Raw{Provider: "deepgram", Model: model}
	if len(dg.Results.Channels) == 0 {
		return raw
	}
	ch := dg.Results.Channels[0]
	raw.Language = ch.DetectedLanguage
	if len(ch.Alternatives) == 0 {
		return raw
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
			seg := transcript.RawSegment{
				Idx:        idx,
				Start:      secToMs(s.Start),
				End:        secToMs(s.End),
				Text:       s.Text,
				Confidence: avgWordConfidence(alt.Words, s.Start, s.End),
				Language:   rangeLanguage(alt.Words, s.Start, s.End),
			}
			seg.Speaker = rangeSpeaker(alt.Words, s.Start, s.End)
			raw.Segments = append(raw.Segments, seg)
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
	return raw
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

// rangeSpeaker returns the dominant speaker inside [start,end]; "" when
// diarization is off.
func rangeSpeaker(words []dgWord, start, end float64) string {
	counts := map[int]int{}
	for _, w := range words {
		if w.Speaker != nil && w.Start >= start && w.End <= end {
			counts[*w.Speaker]++
		}
	}
	best, bestN := 0, 0
	for sp, n := range counts {
		if n > bestN {
			best, bestN = sp, n
		}
	}
	if bestN == 0 {
		return ""
	}
	return strconv.Itoa(best)
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
	Speaker    *int    `json:"speaker"`  // absent unless diarize=true
}
