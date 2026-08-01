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
	"github.com/jiva-studio/shruti/pipeline/outline"
	glossaryport "github.com/jiva-studio/shruti/pipeline/ports/glossary"
	outlineport "github.com/jiva-studio/shruti/pipeline/ports/outline"
	reviewport "github.com/jiva-studio/shruti/pipeline/ports/review"
	translateport "github.com/jiva-studio/shruti/pipeline/ports/translate"
	"github.com/jiva-studio/shruti/pipeline/review"
	"github.com/jiva-studio/shruti/pipeline/transcript"
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
	// Outliner, when set, generates the lecture description + coarse chapter
	// outline from the reviewed transcript via the shared pipeline/outline step.
	// Optional: nil skips it. Best-effort — a failure leaves the track without an
	// outline/description and never blocks the ingest.
	Outliner outlineport.Generator
	// Translator, when set, renders the source title into each non-primary
	// variant's language. Optional and best-effort — nil (or a failure) leaves
	// the variant with the source title, never blocking the ingest.
	Translator translateport.Translator
	// Prober, when set, reads source metadata (uploader, publish date) to fill an
	// author/date the title lacks. Optional and best-effort.
	Prober ports.SourceProber
	// Glossary, when set, injects canonical Sanskrit/proper-noun hints into the
	// LLM review (same dictionary as the corpus tool). Optional.
	Glossary glossaryport.Matcher
	// JobTimeout bounds one Process call so a hung stage can't wedge the
	// single-goroutine consumer indefinitely. 0 disables the deadline.
	JobTimeout time.Duration
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

	// Bound the whole pipeline: a hung stage (e.g. a stalled yt-dlp behind a
	// proxy) would otherwise block the single-goroutine consumer forever. On
	// timeout the stage's ctx-aware call fails, the job dead-letters/retries
	// normally, and the consumer moves on.
	if s.d.JobTimeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, s.d.JobTimeout)
		defer cancel()
	}

	// Every line for this message carries job_id + attempt, so one ingest is a
	// single LogQL filter across the whole pipeline.
	lg := slog.With("job_id", cmd.JobID, "request_id", cmd.RequestID, "attempt", cmd.Attempt)
	started := time.Now()
	lg.InfoContext(ctx, "ingest_started", "url", cmd.URL)

	// Best-effort heartbeat: moves the orchestrator's job queued → running, and
	// reports the first stage (downloading) for granular status.
	s.progress(ctx, cmd, ingest.StageDownloading)

	stage := time.Now()
	// Forward download percent as heartbeats. Throttle to whole-number steps of
	// progressStep so a chatty yt-dlp progress bar can't flood the result stream,
	// while staying fine-grained enough to look smooth (≤20 extra heartbeats). On
	// a fragmented download the real floor is the fragment count, not this step.
	const progressStep = 5
	lastBucket := -1
	onProgress := func(pct int) {
		if b := pct / progressStep; b > lastBucket {
			lastBucket = b
			s.progressPct(ctx, cmd, ingest.StageDownloading, pct)
		}
	}
	localPath, hash, err := s.d.Fetcher.Fetch(ctx, cmd.URL, onProgress)
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

	s.progress(ctx, cmd, ingest.StageTranscribing)
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

	// Source metadata fills what the request didn't carry: the source's own
	// title as a fallback when no hint was passed (a direct URL add), the
	// uploader/channel as an author, and the publish date as a date fallback.
	info := s.probeSource(ctx, lg, cmd.URL)
	// Extract structured metadata from the best title we have — the caller's hint
	// if any, else the source's own title — so a direct URL add still gets a real
	// title, not "Untitled". Best-effort: the audio + transcript are already
	// produced, so a missing key or an LLM hiccup must NOT fail the ingest.
	rawTitle := firstNonEmpty(cmd.Title, info.Title)
	ex := s.extract(ctx, lg, rawTitle)
	draft := ingest.TrackDraft{
		TitleRaw:    firstNonEmpty(ex.Title, rawTitle),
		AuthorRaw:   firstNonEmpty(ex.AuthorRaw, cmd.Author, info.Uploader),
		LocationRaw: ex.LocationRaw,
		LangHint:    raw.Language,
	}
	if ex.Date != nil {
		draft.DateRaw = ex.Date.Format("2006-01-02")
	} else if d, ok := parseYtdlpDate(info.UploadDate); ok {
		draft.DateRaw = d
	}
	if draft, err = s.d.Reviewer.Review(ctx, draft); err != nil {
		return s.fail(ctx, lg, cmd, fmt.Errorf("review: %w", err))
	}

	// Split the transcript by language, review each group into its own
	// transcripts/<lang>.json, and generate that language's overview — a
	// lecturer+translator recording yields one variant per language; a
	// single-language track yields exactly one.
	s.progress(ctx, cmd, ingest.StageReviewing)
	variants, primaryLang, err := s.reviewSplit(ctx, lg, hash, raw, draft.Lang, draft.TitleRaw)
	if err != nil {
		return s.fail(ctx, lg, cmd, err)
	}

	s.progress(ctx, cmd, ingest.StageStoring)
	stage = time.Now()
	aKey := audioKey(hash)
	if err := s.d.Blob.Put(ctx, aKey, audio, "audio/mpeg"); err != nil {
		return s.fail(ctx, lg, cmd, fmt.Errorf("put audio: %w", err))
	}

	// HEAD-verify the audio and every stored transcript before announcing.
	verify := []string{aKey}
	for _, v := range variants {
		verify = append(verify, v.TranscriptKey)
	}
	for _, k := range verify {
		exists, err := s.d.Blob.Exists(ctx, k)
		if err != nil {
			return s.fail(ctx, lg, cmd, fmt.Errorf("verify %s: %w", k, err))
		}
		if !exists {
			return s.fail(ctx, lg, cmd, fmt.Errorf("verify %s: missing after put", k))
		}
	}
	lg.InfoContext(ctx, "ingest_stored",
		"duration_ms", ms(stage), "languages", len(variants),
		"primary_lang", primaryLang, "audio_key", aKey)

	// Cover is best-effort: fetch the source thumbnail and store it under the
	// public cover key. A miss just means the track has no art — never fatal.
	coverKey := s.storeCover(ctx, lg, cmd.URL, hash)

	lg.InfoContext(ctx, "ingest_ready", "lang", primaryLang, "languages", len(variants), "total_ms", ms(started))
	return s.done(ctx, ingest.Result{
		JobID:         cmd.JobID,
		RequestID:     cmd.RequestID,
		Attempt:       cmd.Attempt,
		Phase:         ingest.PhaseReady,
		TrackID:       hash,
		Lang:          primaryLang,
		Title:         draft.TitleRaw,
		AuthorRaw:     draft.AuthorRaw,
		LocationRaw:   draft.LocationRaw,
		Date:          draft.Date,
		KindTag:       ex.KindTag,
		References:    toResultRefs(ex.References),
		CoverKey:      coverKey,
		Duration:      info.Duration * 1000,
		AudioKey:      aKey,
		TranscriptKey: transcriptKey(hash, primaryLang),
		Variants:      variants,
		SourceURL:     cmd.URL,
	})
}

// reviewSplit groups the raw segments by language, reviews each kept group into
// its own transcript, stores it at transcripts/<lang>.json, generates that
// language's overview (description + outline), and returns the variants plus the
// primary (largest surviving) language.
//
// Splitting and ordering use the shared transcript.SplitByLanguage /
// OrderedLanguages so corpus and personal-library tracks agree: a language earns
// its own variant only above the threshold, below-threshold segments fold into
// the primary so nothing is lost. A group that reviews to zero blocks is
// dropped. The whole ingest fails (no_speech) only when NO group produced blocks.
func (s *Service) reviewSplit(
	ctx context.Context, lg *slog.Logger, hash string, raw transcript.Raw, primary, title string,
) ([]ingest.Variant, string, error) {
	groups := transcript.SplitByLanguage(raw.Segments, primary)

	var variants []ingest.Variant
	primaryStored := false
	for _, lang := range transcript.OrderedLanguages(groups, primary) {
		sub := transcript.Raw{TrackId: hash, Language: lang, Segments: transcript.Reindex(groups[lang]), Provider: raw.Provider, Model: raw.Model}
		reviewed := s.d.Reviewer.NormalizeTranscript(sub)
		if s.d.LLMReviewer != nil {
			reviewed = review.ReviewTranscript(ctx, s.d.LLMReviewer, sub, review.Options{Glossary: s.d.Glossary})
		}
		if len(reviewed.Blocks) == 0 {
			lg.WarnContext(ctx, "ingest_language_empty", "lang", lang)
			continue
		}
		body, err := json.Marshal(reviewed)
		if err != nil {
			return nil, "", fmt.Errorf("marshal transcript %s: %w", lang, err)
		}
		tKey := transcriptKey(hash, lang)
		if err := s.d.Blob.Put(ctx, tKey, body, "application/json"); err != nil {
			return nil, "", fmt.Errorf("put transcript %s: %w", lang, err)
		}
		// Overview generated FROM this language's own blocks (best-effort).
		description, chapters := s.outline(ctx, lg, reviewed.Blocks, lang)
		variants = append(variants, ingest.Variant{
			Lang:          lang,
			Title:         s.variantTitle(ctx, lg, title, primary, lang),
			TranscriptKey: tKey,
			Description:   description,
			Outline:       chapters,
		})
		if lang == primary {
			primaryStored = true
		}
	}
	if len(variants) == 0 {
		return nil, "", fmt.Errorf("transcription produced no blocks")
	}
	// The primary group can be dropped as empty while a secondary survives; the
	// first stored variant then becomes the primary label.
	if !primaryStored {
		primary = variants[0].Lang
	}
	return variants, primary, nil
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

// progress emits a best-effort processing heartbeat carrying the current
// pipeline stage, so the orchestrator can serve granular status to a polling
// client. Fire-and-forget — a dropped heartbeat only means a coarser spinner.
func (s *Service) progress(ctx context.Context, cmd ingest.WorkCommand, stage string) {
	s.emit(ctx, ingest.Result{
		JobID:     cmd.JobID,
		RequestID: cmd.RequestID,
		Attempt:   cmd.Attempt,
		Phase:     ingest.PhaseProcessing,
		Stage:     stage,
	})
}

// progressPct is a stage heartbeat carrying a completion percent (the downloading
// stage), so the status card can show "Downloading 40%". Same best-effort emit.
func (s *Service) progressPct(ctx context.Context, cmd ingest.WorkCommand, stage string, percent int) {
	s.emit(ctx, ingest.Result{
		JobID:     cmd.JobID,
		RequestID: cmd.RequestID,
		Attempt:   cmd.Attempt,
		Phase:     ingest.PhaseProcessing,
		Stage:     stage,
		Percent:   percent,
	})
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

// outline generates the lecture description + coarse chapter list from the
// reviewed transcript via the shared pipeline step. Best-effort: a nil Outliner
// or any error yields empty results — the track is stored without an outline.
func (s *Service) outline(ctx context.Context, lg *slog.Logger, blocks []transcript.Block, lang string) (string, []ingest.OutlineEntry) {
	if s.d.Outliner == nil {
		return "", nil
	}
	res, err := outline.Generate(ctx, s.d.Outliner, blocks, lang)
	if err != nil {
		lg.WarnContext(ctx, "ingest_outline_failed", "error", err.Error())
		return "", nil
	}
	chapters := make([]ingest.OutlineEntry, len(res.Coarse))
	for i, c := range res.Coarse {
		chapters[i] = ingest.OutlineEntry{Title: c.Title, Start: c.Start, End: c.End}
	}
	return res.Description, chapters
}

// variantTitle renders the source title into a variant's language. The primary
// variant keeps the source title verbatim; others are translated (best-effort:
// a nil Translator or any error falls back to the source title).
func (s *Service) variantTitle(ctx context.Context, lg *slog.Logger, title, primary, lang string) string {
	if s.d.Translator == nil || lang == primary || title == "" {
		return title
	}
	translated, err := s.d.Translator.Translate(ctx, title, primary, lang)
	if err != nil {
		lg.WarnContext(ctx, "ingest_title_translate_failed", "lang", lang, "error", err.Error())
		return title
	}
	return translated
}

// probeSource reads best-effort source metadata (uploader, publish date). A nil
// Prober or any error yields a zero SourceInfo — the pipeline just keeps
// whatever the title extraction produced.
func (s *Service) probeSource(ctx context.Context, lg *slog.Logger, url string) ports.SourceInfo {
	if s.d.Prober == nil {
		return ports.SourceInfo{}
	}
	info, err := s.d.Prober.ProbeSource(ctx, url)
	if err != nil {
		lg.WarnContext(ctx, "ingest_probe_failed", "error", err.Error())
		return ports.SourceInfo{}
	}
	return info
}

// parseYtdlpDate turns yt-dlp's "YYYYMMDD" publish date into the canonical ISO
// "YYYY-MM-DD"; ok is false for an empty or malformed value.
func parseYtdlpDate(s string) (string, bool) {
	if t, err := time.Parse("20060102", strings.TrimSpace(s)); err == nil {
		return t.Format("2006-01-02"), true
	}
	return "", false
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
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
