package mcpsrv

// Sentence-level transcript slicing for the excerpt player.
//
// The published transcript artifact (public/tracks/<id>/transcripts/<lang>.json)
// holds one block per sentence with absolute ms timings — the same file the
// mobile app reads. Slicing it beats joining the retrieval chunks the `chunks`
// table returns for the window: those overlap by design, so a join repeats every
// sentence two to four times.

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/jiva-studio/lectorium/modules/services/lectorium-corpus-mcp/internal/catalog"
)

const (
	transcriptCacheTTL  = 15 * time.Minute
	transcriptCacheMax  = 64
	transcriptMaxBlocks = 1000
	transcriptMaxChars  = 24000
)

var transcriptHTTP = &http.Client{Timeout: 15 * time.Second}

type transcriptBlock struct {
	Type  string `json:"type"`
	Start int    `json:"start"`
	End   int    `json:"end"`
	Text  string `json:"text"`
}

type transcriptDoc struct {
	Blocks []transcriptBlock `json:"blocks"`
}

type cachedTranscript struct {
	doc *transcriptDoc
	at  time.Time
}

var transcripts = struct {
	mu sync.Mutex
	m  map[string]cachedTranscript
}{m: map[string]cachedTranscript{}}

func transcriptFromCache(url string) *transcriptDoc {
	transcripts.mu.Lock()
	defer transcripts.mu.Unlock()
	c, ok := transcripts.m[url]
	if !ok || time.Since(c.at) > transcriptCacheTTL {
		return nil
	}
	return c.doc
}

func cacheTranscript(url string, doc *transcriptDoc) {
	transcripts.mu.Lock()
	defer transcripts.mu.Unlock()
	if len(transcripts.m) >= transcriptCacheMax {
		for k, c := range transcripts.m {
			if time.Since(c.at) > transcriptCacheTTL {
				delete(transcripts.m, k)
			}
		}
		if len(transcripts.m) >= transcriptCacheMax {
			transcripts.m = map[string]cachedTranscript{}
		}
	}
	transcripts.m[url] = cachedTranscript{doc: doc, at: time.Now()}
}

func fetchTranscript(ctx context.Context, url string) *transcriptDoc {
	if doc := transcriptFromCache(url); doc != nil {
		return doc
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil
	}
	resp, err := transcriptHTTP.Do(req)
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	var doc transcriptDoc
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		return nil
	}
	cacheTranscript(url, &doc)
	return &doc
}

// sliceTranscript keeps the sentence blocks that fall ENTIRELY inside [lo, hi].
// A sentence straddling either edge is dropped: the clip is cut at exactly
// those bounds, so only part of it is audible and printing it whole would show
// words the listener never hears.
//
// The caps are corruption rails, not content limits — the excerpt itself is
// capped at 10 minutes, and the densest 10-minute window measured across the
// corpus is ~13k characters / ~160 sentences.
func sliceTranscript(doc *transcriptDoc, lo, hi int) []transcriptBlock {
	out := make([]transcriptBlock, 0, 32)
	chars := 0
	for _, b := range doc.Blocks {
		if b.Type != "" && b.Type != "sentence" {
			continue
		}
		if b.Start < lo || b.End > hi {
			continue
		}
		text := strings.TrimSpace(b.Text)
		if text == "" {
			continue
		}
		b.Text = text
		out = append(out, b)
		chars += len(text)
		if len(out) >= transcriptMaxBlocks || chars >= transcriptMaxChars {
			break
		}
	}
	return out
}

// excerptTranscript returns the spoken sentences of [lo, hi] as widget-ready
// segments plus their joined plain text, and the transcript language actually
// used. All three are empty when the track has no transcript in reach.
func (d *Deps) excerptTranscript(ctx context.Context, tr *catalog.Track, lang string, lo, hi int) (segments []map[string]any, text, effLang string) {
	segments = []map[string]any{}
	path, effLang := tr.TranscriptPath(lang)
	if path == "" {
		return segments, "", ""
	}
	doc := fetchTranscript(ctx, d.Cfg.MediaBase()+"/"+strings.TrimPrefix(path, "/"))
	if doc == nil {
		return segments, "", ""
	}
	blocks := sliceTranscript(doc, lo, hi)
	parts := make([]string, 0, len(blocks))
	for _, b := range blocks {
		segments = append(segments, map[string]any{
			"start_ms": b.Start,
			"end_ms":   b.End,
			"text":     b.Text,
		})
		parts = append(parts, b.Text)
	}
	return segments, strings.Join(parts, " "), effLang
}
