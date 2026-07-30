// Package runingest is the ingest worker's pipeline use case: it consumes one
// `ingest.work` command, drives it through fetch → content-hash → transcribe →
// review → store, and reports progress and the terminal outcome on the
// `ingest.result` stream. It depends ONLY on ports, so the whole flow is
// exercised with fakes.
//
// The worker is STATELESS — no Postgres, no job store, no retry accounting:
//
//   - Idempotency comes from content-addressing: Fetch is pure and Put writes
//     to `public/tracks/<hash>/…`, so a redelivered `ingest.work` (e.g. after a
//     crash or a lost result before XACK) re-runs safely and converges on the
//     same keys — a duplicate re-transcribe simply overwrites identical bytes.
//   - Stored artifacts match the MCP pipeline exactly: audio at
//     `public/tracks/<hash>/audio/original.mp3` and the reviewed transcript at
//     `public/tracks/<hash>/transcripts/<lang>.json`.
//   - The worker emits ONE terminal result (ready | failed) and acks only once
//     it is durably published. It never retries the pipeline for a business
//     failure and never tracks attempts — the retry policy (and the attempt
//     cap) lives entirely in the orchestrator.
package runingest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/jiva-studio/shruti/ingest/internal/domain/ingest"
	"github.com/jiva-studio/shruti/ingest/internal/ports"
	"github.com/jiva-studio/shruti/pipeline/blobpath"
	"github.com/jiva-studio/shruti/pipeline/metadata"
	reviewport "github.com/jiva-studio/shruti/pipeline/ports/review"
	"github.com/jiva-studio/shruti/pipeline/review"
)

// Deps bundles the ports the pipeline needs.
type Deps struct {
	Fetcher     ports.Fetcher
	Transcriber ports.Transcriber
	Reviewer    ports.Reviewer
	Blob        ports.BlobStore
	Results     ports.ResultPublisher
	// Extractor parses title/metadata (LLM). Optional: nil skips extraction and
	// the track keeps just its raw title — extraction never blocks an ingest.
	Extractor metadata.Extractor
	// LLMReviewer, when set, runs an LLM pass over the transcript (sentence
	// cleanup/segmentation) via the shared review pipeline. Optional: nil falls
	// back to the deterministic per-segment NormalizeTranscript. Best-effort —
	// per-chunk failures degrade to raw text, never blocking the ingest.
	LLMReviewer reviewport.Reviewer
}

// Service runs the pipeline.
type Service struct {
	d Deps
}

// New builds a Service.
func New(d Deps) *Service { return &Service{d: d} }

// Process handles one `ingest.work` message. It returns nil (safe to XACK) only
// after the TERMINAL result (ready | failed) is durably published; a publish
// fault on the terminal result returns an error so the entry stays pending and
// redelivery re-runs the (content-addressed, idempotent) pipeline. The worker
// never retries the pipeline for a business failure — the orchestrator owns that
// from the Retriable flag. A non-decodable payload is a poison pill (nil, drop).
func (s *Service) Process(ctx context.Context, _ string, payload []byte) error {
	cmd, err := ingest.DecodeWork(payload)
	if err != nil {
		// Poison pill. This is the ONE path with no job_id to correlate on, so
		// log it — otherwise a malformed producer drops messages invisibly.
		slog.WarnContext(ctx, "ingest_poison_pill", "error", err.Error(), "bytes", len(payload))
		return nil // unparseable; ack to drop it
	}

	// Every line for this message carries job_id + attempt, so one ingest is a
	// single LogQL filter across the whole pipeline.
	lg := slog.With("job_id", cmd.JobID, "request_id", cmd.RequestID, "attempt", cmd.Attempt)
	started := time.Now()
	lg.InfoContext(ctx, "ingest_started", "url", cmd.URL)

	// Best-effort heartbeat: moves the orchestrator's job queued → running.
	s.emit(ctx, ingest.Result{JobID: cmd.JobID, RequestID: cmd.RequestID, Attempt: cmd.Attempt, Phase: ingest.PhaseProcessing})

	stage := time.Now()
	localPath, hash, err := s.d.Fetcher.Fetch(ctx, cmd.URL)
	if err != nil {
		return s.fail(ctx, lg, cmd, fmt.Errorf("fetch: %w", err))
	}
	defer os.RemoveAll(filepath.Dir(localPath))
	lg = lg.With("track_id", hash) // known from here on — carry it forward
	lg.InfoContext(ctx, "ingest_fetched", "duration_ms", ms(stage))

	audio, err := os.ReadFile(localPath)
	if err != nil {
		return s.fail(ctx, lg, cmd, fmt.Errorf("read audio: %w", err))
	}

	stage = time.Now()
	raw, _, err := s.d.Transcriber.Transcribe(ctx, localPath)
	if err != nil {
		return s.fail(ctx, lg, cmd, fmt.Errorf("transcribe: %w", err))
	}
	lg.InfoContext(ctx, "ingest_transcribed",
		"duration_ms", ms(stage), "lang", raw.Language, "audio_bytes", len(audio))
	raw.TrackId = hash
	if raw.Language == "" {
		raw.Language = "und" // keep the transcripts/<lang>.json key well-formed
	}

	// Turn raw ASR segments into the reviewed artifact the corpus/app read
	// (transcript.Reviewed). With an LLM reviewer configured, run the shared
	// review pipeline (chunk → LLM cleanup → sentence assembly); otherwise the
	// deterministic per-segment windowing. LLM review is best-effort — per-chunk
	// failures degrade to raw text inside ReviewTranscript, never fatal.
	reviewed := s.d.Reviewer.NormalizeTranscript(raw)
	if s.d.LLMReviewer != nil {
		reviewed = review.ReviewTranscript(ctx, s.d.LLMReviewer, raw, review.Options{})
	}
	if len(reviewed.Blocks) == 0 {
		// Deepgram returned 200 but no usable speech. Announcing this as ready
		// would store an empty transcript the app/corpus can't use, with no
		// recovery. Fail RETRIABLY (not ErrPermanent): a transient ASR hiccup
		// clears on retry, and a genuinely silent source dead-letters as failed
		// after the attempt cap rather than masquerading as a ready track.
		return s.fail(ctx, lg, cmd, fmt.Errorf("transcription produced no blocks"))
	}
	transcriptBody, err := json.Marshal(reviewed)
	if err != nil {
		return s.fail(ctx, lg, cmd, fmt.Errorf("marshal transcript: %w", err))
	}

	// Extract structured metadata from the title (date / author / location /
	// clean title / references / kind). Best-effort: the audio + transcript are
	// already produced, so a missing key or an LLM hiccup must NOT fail the
	// ingest — we just fall back to the raw title.
	ex := s.extract(ctx, lg, cmd.Title)
	draft := ingest.TrackDraft{
		TitleRaw:    firstNonEmpty(ex.Title, cmd.Title),
		AuthorRaw:   ex.AuthorRaw,
		LocationRaw: ex.LocationRaw,
		LangHint:    raw.Language,
	}
	if ex.Date != nil {
		draft.DateRaw = ex.Date.Format("2006-01-02")
	}
	if draft, err = s.d.Reviewer.Review(ctx, draft); err != nil {
		return s.fail(ctx, lg, cmd, fmt.Errorf("review: %w", err))
	}
	lang := draft.Lang

	stage = time.Now()
	aKey, tKey := audioKey(hash), transcriptKey(hash, lang)
	if err := s.d.Blob.Put(ctx, aKey, audio, "audio/mpeg"); err != nil {
		return s.fail(ctx, lg, cmd, fmt.Errorf("put audio: %w", err))
	}
	if err := s.d.Blob.Put(ctx, tKey, transcriptBody, "application/json"); err != nil {
		return s.fail(ctx, lg, cmd, fmt.Errorf("put transcript: %w", err))
	}

	// HEAD-verify both artifacts before announcing the track.
	for _, k := range []string{aKey, tKey} {
		exists, err := s.d.Blob.Exists(ctx, k)
		if err != nil {
			return s.fail(ctx, lg, cmd, fmt.Errorf("verify %s: %w", k, err))
		}
		if !exists {
			return s.fail(ctx, lg, cmd, fmt.Errorf("verify %s: missing after put", k))
		}
	}
	lg.InfoContext(ctx, "ingest_stored",
		"duration_ms", ms(stage), "blocks", len(reviewed.Blocks),
		"audio_key", aKey, "transcript_key", tKey)

	// Cover is best-effort: fetch the source thumbnail and store it under the
	// public cover key. A miss just means the track has no art — never fatal.
	coverKey := s.storeCover(ctx, lg, cmd.URL, hash)

	lg.InfoContext(ctx, "ingest_ready", "lang", lang, "total_ms", ms(started))
	return s.done(ctx, ingest.Result{
		JobID:         cmd.JobID,
		RequestID:     cmd.RequestID,
		Attempt:       cmd.Attempt,
		Phase:         ingest.PhaseReady,
		TrackID:       hash,
		Lang:          lang,
		Title:         draft.TitleRaw,
		AuthorRaw:     draft.AuthorRaw,
		LocationRaw:   draft.LocationRaw,
		Date:          draft.Date,
		KindTag:       ex.KindTag,
		References:    toResultRefs(ex.References),
		CoverKey:      coverKey,
		AudioKey:      aKey,
		TranscriptKey: tKey,
		SourceURL:     cmd.URL,
	})
}

// fail publishes a terminal failed result (classifying transient vs permanent).
// It returns the publish error (if any) so a lost terminal result redelivers;
// the orchestrator decides re-dispatch from the Retriable flag and its cap.
//
// Log level splits on the SAME classification: a permanent failure is a business
// outcome (a dead or private URL — the user's problem, not ours) and logs at
// Warn, while a retriable one means our own dependency misbehaved and logs at
// Error. That keeps a corpus-wide "error rate" signal meaningful instead of
// drowning it in bad links.
func (s *Service) fail(ctx context.Context, lg *slog.Logger, cmd ingest.WorkCommand, cause error) error {
	retry := retriable(cause)
	lvl := slog.LevelError
	if !retry {
		lvl = slog.LevelWarn
	}
	lg.Log(ctx, lvl, "ingest_failed", "error", cause.Error(), "retriable", retry)
	return s.done(ctx, ingest.Result{
		JobID:     cmd.JobID,
		RequestID: cmd.RequestID,
		Attempt:   cmd.Attempt,
		Phase:     ingest.PhaseFailed,
		Error:     cause.Error(),
		Retriable: retry,
	})
}

// ms reports elapsed milliseconds for a stage timing attribute.
func ms(since time.Time) int64 { return time.Since(since).Milliseconds() }

// done publishes a TERMINAL result and propagates the publish error: the worker
// acks only once the outcome is durable (a publish fault → redelivery re-runs).
func (s *Service) done(ctx context.Context, r ingest.Result) error {
	return s.d.Results.Publish(ctx, r)
}

// emit publishes a NON-terminal heartbeat, best-effort: a publish failure is not
// fatal because the terminal result still carries the outcome.
func (s *Service) emit(ctx context.Context, r ingest.Result) {
	_ = s.d.Results.Publish(ctx, r)
}

// retriable classifies a pipeline error. Clearly-permanent failures — an
// unsupported/invalid URL, a deleted/private/age-restricted source, a 4xx, or a
// source that exceeds the size/duration limits — are wrapped with
// ingest.ErrPermanent by the fetch adapter and reported non-retriable
// (re-running can't help). Everything else (network blips, 5xx, timeouts,
// transcribe/put faults) is transient, so the orchestrator may re-dispatch.
func retriable(err error) bool {
	return !errors.Is(err, ingest.ErrPermanent)
}

// extract runs the metadata extractor best-effort. No extractor configured (no
// LLM key), a blank title, or any extract error all yield an empty result — the
// caller falls back to the raw title. Extraction must never fail an ingest whose
// audio + transcript are already stored.
func (s *Service) extract(ctx context.Context, lg *slog.Logger, title string) metadata.Extracted {
	if s.d.Extractor == nil || strings.TrimSpace(title) == "" {
		return metadata.Extracted{}
	}
	ex, err := s.d.Extractor.Extract(ctx, title, nil)
	if err != nil {
		lg.WarnContext(ctx, "ingest_extract_failed", "error", err.Error())
		return metadata.Extracted{}
	}
	return ex
}

func firstNonEmpty(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}

func toResultRefs(refs []metadata.Ref) []ingest.Ref {
	if len(refs) == 0 {
		return nil
	}
	out := make([]ingest.Ref, 0, len(refs))
	for _, r := range refs {
		// Raw code → sourceName (unresolved, rendered as-is); dot-joined tokens
		// → the token array the domain Reference carries.
		out = append(out, ingest.Ref{SourceName: r.SourceCode, Tokens: splitTokens(r.Tokens)})
	}
	return out
}

// splitTokens turns "2.13" into ["2","13"], dropping empty segments.
func splitTokens(s string) []string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	var out []string
	for _, t := range strings.Split(s, ".") {
		if t = strings.TrimSpace(t); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// _ytIDRe pulls the 11-char video id out of any watch / shorts / live / youtu.be
// URL so we can build the free cover image URL from it.
var _ytIDRe = regexp.MustCompile(`(?:youtube\.com/(?:watch\?[^\s]*\bv=|shorts/|live/)|youtu\.be/)([\w-]{11})`)

// storeCover fetches the source's thumbnail (YouTube only, from its free
// i.ytimg.com cover) and stores it at the public cover key. Best-effort: no
// derivable thumbnail, a fetch/put error, or an empty body all yield "" and the
// track simply has no art — a cover miss never fails an ingest.
//
// It prefers the 16:9 variants (maxresdefault, then the always-present
// mqdefault); the 4:3 hqdefault YouTube pillar-boxes 16:9 footage into black
// bars, which then survive the square crop on the client.
func (s *Service) storeCover(ctx context.Context, lg *slog.Logger, sourceURL, hash string) string {
	m := _ytIDRe.FindStringSubmatch(sourceURL)
	if m == nil {
		return ""
	}
	var body []byte
	var ctype string
	for _, name := range []string{"maxresdefault", "mqdefault"} {
		b, ct, err := httpGetImage(ctx, "https://i.ytimg.com/vi/"+m[1]+"/"+name+".jpg")
		if err == nil && len(b) > 0 {
			body, ctype = b, ct
			break
		}
	}
	if len(body) == 0 {
		lg.WarnContext(ctx, "ingest_cover_fetch_failed", "video_id", m[1])
		return ""
	}
	key := blobpath.CoverKey(hash)
	if ctype == "" {
		ctype = "image/jpeg"
	}
	if err := s.d.Blob.Put(ctx, key, body, ctype); err != nil {
		lg.WarnContext(ctx, "ingest_cover_put_failed", "error", err.Error())
		return ""
	}
	return key
}

// httpGetImage fetches an image URL with a short timeout, returning its bytes
// and content-type. Non-200 is an error.
func httpGetImage(ctx context.Context, url string) ([]byte, string, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("cover GET %s: HTTP %d", url, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8*1024*1024))
	if err != nil {
		return nil, "", err
	}
	return body, resp.Header.Get("Content-Type"), nil
}

// --- blob keys (content-addressed public path; shared scheme with the MCP pipeline) ---

func audioKey(trackID string) string { return blobpath.AudioKey(trackID, "original") }
func transcriptKey(trackID, lang string) string {
	return blobpath.TranscriptKey(trackID, lang)
}
