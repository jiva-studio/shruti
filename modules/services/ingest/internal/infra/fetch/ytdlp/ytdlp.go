// Package ytdlp implements ports.Fetcher by shelling out to yt-dlp (the same
// tool services/share-video's background pipeline uses). It routes a URL to an
// extractor via a domain registry (yt-dlp for arbitrary sites, a direct HTTP
// path for bare .mp3 links), enforces input limits (max source duration and
// max downloaded bytes), guards the upstream with a circuit breaker, and
// content-addresses the downloaded bytes into the track_id.
package ytdlp

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jiva-studio/lectorium/ingest/internal/domain/ingest"
	"github.com/jiva-studio/lectorium/ingest/internal/infra/netguard"
	"github.com/jiva-studio/lectorium/ingest/internal/ports"
)

// permanentYtdlpMarkers are yt-dlp stderr fragments (lowercased) that mean the
// source is gone for good — re-running won't help. Kept conservative: a marker
// here makes the failure NON-retriable, so only add unambiguous ones (a bare
// "http error 403" or a network timeout stays retriable).
var permanentYtdlpMarkers = []string{
	"video unavailable",
	"private video",
	"this video has been removed",
	"removed by the user",
	"account associated with this video has been terminated",
	"this video is no longer available",
	"members-only",
	"join this channel",
	"sign in to confirm your age",
	"age-restricted",
	"not available in your country",
	"blocked it in your country",
	"unsupported url",
	"is not a valid url",
	"incomplete youtube id",
	"http error 404",
	"http error 410",
	"requested format is not available",
}

// classifyDownloadErr wraps a yt-dlp failure with ingest.ErrPermanent when its
// stderr identifies a permanent source condition. yt-dlp exits non-zero for both
// transient (network) and permanent (deleted/private) failures with the same
// "exit status 1", so the signal lives in stderr — which os/exec's Output()
// captures into (*exec.ExitError).Stderr.
func classifyDownloadErr(err error) error {
	haystack := strings.ToLower(err.Error())
	var ee *exec.ExitError
	if errors.As(err, &ee) && len(ee.Stderr) > 0 {
		haystack += "\n" + strings.ToLower(string(ee.Stderr))
	}
	var re *runError
	if errors.As(err, &re) && re.stderr != "" {
		haystack += "\n" + strings.ToLower(re.stderr)
	}
	for _, m := range permanentYtdlpMarkers {
		if strings.Contains(haystack, m) {
			return fmt.Errorf("yt-dlp (permanent): %w: %s", ingest.ErrPermanent, firstLine(err))
		}
	}
	return fmt.Errorf("yt-dlp: %w", err)
}

// firstLine returns a short, human-readable reason for the failed result's Error
// field, preferring the stderr the exit error (buffered path) or runError
// (streaming path) carries over the bare "exit status 1".
func firstLine(err error) string {
	var ee *exec.ExitError
	if errors.As(err, &ee) && len(ee.Stderr) > 0 {
		return firstStderrLine(string(ee.Stderr))
	}
	var re *runError
	if errors.As(err, &re) && re.stderr != "" {
		return firstStderrLine(re.stderr)
	}
	s := err.Error()
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	return strings.TrimSpace(s)
}

// Runner executes an external command and returns its combined stdout. Injected
// so the extractor logic can be unit-tested without a real yt-dlp binary.
type Runner func(ctx context.Context, name string, args ...string) ([]byte, error)

func execRunner(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).Output()
}

// ProgressRunner streams a command's stdout line-by-line to onLine as it runs,
// so the yt-dlp download's progress lines can be parsed live. It returns only
// the terminal error (with stderr attached for classification). Injected so the
// streaming path stays testable; nil falls the download back to the buffered
// Runner with no percent.
type ProgressRunner func(ctx context.Context, onLine func(string), name string, args ...string) error

// execProgressRunner runs a command, scanning BOTH stdout and stderr for
// progress lines — yt-dlp writes its progress bar to one or the other depending
// on version / TTY, so watching only stdout silently loses every percent. It
// still captures stderr text so a failure can be classified (permanent vs
// transient) and surfaced as a human reason, like (*exec.ExitError).Stderr.
func execProgressRunner(ctx context.Context, onLine func(string), name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}

	var mu sync.Mutex
	var stderrBuf strings.Builder
	var wg sync.WaitGroup
	scan := func(r io.Reader, capture bool) {
		defer wg.Done()
		sc := bufio.NewScanner(r)
		sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for sc.Scan() {
			line := sc.Text()
			mu.Lock()
			if capture {
				stderrBuf.WriteString(line)
				stderrBuf.WriteByte('\n')
			}
			onLine(line) // serialized, so onProgress's throttle stays single-threaded
			mu.Unlock()
		}
	}
	wg.Add(2)
	go scan(stdout, false)
	go scan(stderrPipe, true)
	wg.Wait()

	if err := cmd.Wait(); err != nil {
		return &runError{err: err, stderr: stderrBuf.String()}
	}
	return nil
}

// runError carries a streamed download's stderr so classifyDownloadErr can both
// classify the failure and surface a human reason — the StdoutPipe path leaves
// (*exec.ExitError).Stderr empty, so we attach it here explicitly.
type runError struct {
	err    error
	stderr string
}

func (e *runError) Error() string {
	if s := strings.TrimSpace(firstStderrLine(e.stderr)); s != "" {
		return s
	}
	return e.err.Error()
}

func (e *runError) Unwrap() error { return e.err }

// firstStderrLine returns the last non-empty stderr line — yt-dlp prints the
// actual "ERROR: …" reason at the end, after any progress/warning chatter.
func firstStderrLine(s string) string {
	lines := strings.Split(s, "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if l := strings.TrimSpace(lines[i]); l != "" {
			return l
		}
	}
	return ""
}

// progressTemplate + progressPrefix tag yt-dlp's download progress so we can
// pick our percent lines out of its other chatter. We emit the byte percent
// AND the fragment index/count, pipe-separated, because a fragmented (HLS/DASH)
// YouTube download reports "_percent_str" as "NA%" (no known total) — there the
// fragment ratio is the only real measure. A line looks like:
//
//	PCT:  42.3%|12|50
const (
	progressPrefix = "PCT:"
	progressTemplate = "download:" + progressPrefix +
		"%(progress._percent_str)s|%(progress.fragment_index)s|%(progress.fragment_count)s"
)

// parsePercent extracts a 0-100 integer from a tagged progress line
// ("PCT:  42.3%|12|50"), preferring the byte percent and falling back to the
// fragment ratio when the byte total is unknown ("NA%"). ok is false for any
// other line or when neither measure is available.
func parsePercent(line string) (int, bool) {
	line = strings.TrimSpace(line)
	if !strings.HasPrefix(line, progressPrefix) {
		return 0, false
	}
	fields := strings.Split(strings.TrimPrefix(line, progressPrefix), "|")

	// Byte percent (yt-dlp's _percent_str, e.g. "  42.3%"); "NA%" won't parse.
	pctStr := strings.TrimSuffix(strings.TrimSpace(fields[0]), "%")
	if f, err := strconv.ParseFloat(pctStr, 64); err == nil && f >= 0 {
		return clampPercent(f), true
	}

	// Fallback: fragment_index / fragment_count for fragmented downloads.
	if len(fields) >= 3 {
		idx, e1 := strconv.Atoi(strings.TrimSpace(fields[1]))
		cnt, e2 := strconv.Atoi(strings.TrimSpace(fields[2]))
		if e1 == nil && e2 == nil && cnt > 0 && idx >= 0 {
			return clampPercent(float64(idx) * 100 / float64(cnt)), true
		}
	}
	return 0, false
}

func clampPercent(f float64) int {
	if f < 0 {
		return 0
	}
	if f > 100 {
		return 100
	}
	return int(f)
}

// Options configure the Fetcher.
type Options struct {
	Bin         string        // yt-dlp binary (default "yt-dlp")
	Proxy       string        // host-only proxy passed to --proxy (empty = none)
	MaxBytes    int64         // reject artifacts larger than this (0 = unlimited)
	MaxSeconds  int64         // reject sources longer than this (0 = unlimited)
	WorkDir     string        // parent dir for per-fetch temp dirs (default os.TempDir)
	BreakerN    int           // consecutive failures before the breaker opens
	BreakerCool time.Duration // breaker cooldown
	Runner      Runner        // command runner (default exec)
	// ProgressRunner streams yt-dlp's download so the percent can be reported
	// live (default exec). A test may leave it nil to force the buffered path.
	ProgressRunner ProgressRunner
	HTTPClient     *http.Client // client for the direct-mp3 extractor
	FFmpegBin      string       // ffmpeg binary for the CBR re-encode (default "ffmpeg")
}

// Fetcher is the ports.Fetcher implementation.
type Fetcher struct {
	opts    Options
	reg     *registry
	breaker *breaker
}

// New builds a Fetcher with the default extractor registry (yt-dlp default +
// direct-mp3 for *.mp3 URLs).
func New(opts Options) *Fetcher {
	if opts.Bin == "" {
		opts.Bin = "yt-dlp"
	}
	if opts.Runner == nil {
		opts.Runner = execRunner
	}
	if opts.ProgressRunner == nil {
		opts.ProgressRunner = execProgressRunner
	}
	if opts.HTTPClient == nil {
		// Control also covers redirects, which CheckURL cannot.
		opts.HTTPClient = &http.Client{
			Timeout: 10 * time.Minute,
			Transport: &http.Transport{
				DialContext: (&net.Dialer{
					Timeout:   30 * time.Second,
					KeepAlive: 30 * time.Second,
					Control:   netguard.DialControl,
				}).DialContext,
			},
		}
	}
	if opts.FFmpegBin == "" {
		opts.FFmpegBin = "ffmpeg"
	}
	if opts.WorkDir == "" {
		opts.WorkDir = os.TempDir()
	}
	f := &Fetcher{
		opts:    opts,
		breaker: newBreaker(opts.BreakerN, opts.BreakerCool),
	}
	f.reg = newRegistry(&ytdlpExtractor{opts: &f.opts}, &mp3Extractor{opts: &f.opts})
	return f
}

// Fetch downloads url, enforces limits, and returns the local audio path plus
// the content hash (track_id). onProgress (nil-safe) receives download-percent
// updates while the bytes arrive.
func (f *Fetcher) Fetch(ctx context.Context, rawURL string, onProgress func(int)) (string, string, error) {
	if !f.breaker.allow() {
		return "", "", ErrCircuitOpen
	}
	localPath, hash, err := f.fetch(ctx, rawURL, onProgress)
	// A permanent error is a user-fault source (dead / private / age-restricted /
	// too-long link), not our dependency misbehaving. Leave the breaker untouched
	// so a run of bad links can't open it against healthy ingests — nor reset a
	// genuine infra-failure streak. Only infra (network/5xx/timeout) outcomes
	// move the breaker.
	if !errors.Is(err, ingest.ErrPermanent) {
		f.breaker.record(err == nil)
	}
	return localPath, hash, err
}

func (f *Fetcher) fetch(ctx context.Context, rawURL string, onProgress func(int)) (string, string, error) {
	u, err := url.Parse(rawURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", "", fmt.Errorf("fetch: invalid url %q: %w", rawURL, ingest.ErrPermanent)
	}
	// The URL comes from the submitter; yt-dlp dials in its own process.
	if err := netguard.CheckURL(ctx, rawURL); err != nil {
		return "", "", fmt.Errorf("fetch: %w: %w", err, ingest.ErrPermanent)
	}
	ext := f.reg.pick(u)

	// Enforce the duration limit BEFORE downloading when the extractor can
	// probe it cheaply.
	if f.opts.MaxSeconds > 0 {
		if dur, ok := ext.probeDuration(ctx, rawURL); ok && dur > f.opts.MaxSeconds {
			return "", "", fmt.Errorf("fetch: source duration %ds exceeds limit %ds: %w", dur, f.opts.MaxSeconds, ingest.ErrPermanent)
		}
	}

	dir, err := os.MkdirTemp(f.opts.WorkDir, "ingest-*")
	if err != nil {
		return "", "", fmt.Errorf("fetch: tempdir: %w", err)
	}
	path, err := ext.download(ctx, rawURL, dir, onProgress)
	if err != nil {
		_ = os.RemoveAll(dir)
		return "", "", err
	}

	// Re-encode to constant-bitrate mp3 (same libmp3lame -b:a 128k the corpus
	// pipeline uses). A VBR mp3 — what yt-dlp and many direct sources produce —
	// carries only a coarse 100-point Xing seek table, so a browser estimates
	// currentTime / seek by interpolating between those points and drifts by
	// seconds on a long lecture, desyncing the transcript highlight. CBR makes
	// byte-offset ↔ time exact. Both the stored audio AND the transcript are
	// derived from this file, so they stay consistent.
	if reenc, rerr := f.reencodeCBR(ctx, path); rerr != nil {
		_ = os.RemoveAll(dir)
		return "", "", fmt.Errorf("fetch: reencode: %w", rerr)
	} else {
		path = reenc
	}

	fi, err := os.Stat(path)
	if err != nil {
		_ = os.RemoveAll(dir)
		return "", "", fmt.Errorf("fetch: stat: %w", err)
	}
	if f.opts.MaxBytes > 0 && fi.Size() > f.opts.MaxBytes {
		_ = os.RemoveAll(dir)
		return "", "", fmt.Errorf("fetch: artifact %d bytes exceeds limit %d: %w", fi.Size(), f.opts.MaxBytes, ingest.ErrPermanent)
	}

	b, err := os.ReadFile(path)
	if err != nil {
		_ = os.RemoveAll(dir)
		return "", "", fmt.Errorf("fetch: read artifact: %w", err)
	}
	return path, ingest.ContentID(b), nil
}

// reencodeCBR transcodes the downloaded audio to constant-bitrate mp3 in place,
// matching the corpus pipeline's `libmp3lame -b:a 128k`, and returns the new
// path (the source file is removed). A re-encode fault is returned so the ingest
// retries rather than silently storing a seek-broken VBR file.
func (f *Fetcher) reencodeCBR(ctx context.Context, path string) (string, error) {
	out := path + ".cbr.mp3"
	if _, err := f.opts.Runner(ctx, f.opts.FFmpegBin,
		"-y", "-hide_banner", "-loglevel", "error",
		"-i", path,
		"-c:a", "libmp3lame", "-b:a", "128k",
		out,
	); err != nil {
		return "", err
	}
	_ = os.Remove(path)
	return out, nil
}

// ProbeSource reads best-effort source metadata (uploader + publish date)
// without downloading media, so the pipeline can fill an author/date the title
// lacks. Empty fields (or a whole empty result) when yt-dlp can't provide them
// — e.g. a direct-mp3 URL; a probe failure is never surfaced as an error.
func (f *Fetcher) ProbeSource(ctx context.Context, rawURL string) (ports.SourceInfo, error) {
	args := []string{"--no-playlist", "--skip-download", "--print", "%(title)s\n%(uploader)s\n%(upload_date)s\n%(duration)s"}
	if f.opts.Proxy != "" {
		args = append(args, "--proxy", f.opts.Proxy)
	}
	args = append(args, "--", rawURL)
	out, err := f.opts.Runner(ctx, f.opts.Bin, args...)
	if err != nil {
		return ports.SourceInfo{}, nil
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	var info ports.SourceInfo
	if len(lines) > 0 {
		info.Title = naToEmpty(lines[0])
	}
	if len(lines) > 1 {
		info.Uploader = naToEmpty(lines[1])
	}
	if len(lines) > 2 {
		info.UploadDate = naToEmpty(lines[2])
	}
	if len(lines) > 3 {
		// yt-dlp prints duration in seconds (integer, or a float for some
		// extractors); truncate to whole seconds — sub-second is irrelevant here.
		if sec, perr := strconv.ParseFloat(naToEmpty(lines[3]), 64); perr == nil && sec > 0 {
			info.Duration = int64(sec)
		}
	}
	return info, nil
}

// naToEmpty maps yt-dlp's "NA" placeholder (and blanks) to "".
func naToEmpty(s string) string {
	s = strings.TrimSpace(s)
	if s == "NA" {
		return ""
	}
	return s
}

// --- extractor registry ---

// extractor downloads a URL to a local file and can probe its duration.
// onProgress (nil-safe) reports download percent while the bytes arrive.
type extractor interface {
	// handles reports whether this extractor claims the URL.
	handles(u *url.URL) bool
	download(ctx context.Context, rawURL, destDir string, onProgress func(int)) (string, error)
	probeDuration(ctx context.Context, rawURL string) (int64, bool)
}

type registry struct {
	def   extractor   // fallback (yt-dlp)
	named []extractor // domain/scheme-specific, tried first
}

func newRegistry(def extractor, named ...extractor) *registry {
	return &registry{def: def, named: named}
}

// pick returns the first named extractor that handles u, else the default.
func (r *registry) pick(u *url.URL) extractor {
	for _, e := range r.named {
		if e.handles(u) {
			return e
		}
	}
	return r.def
}

// --- yt-dlp extractor (default) ---

type ytdlpExtractor struct{ opts *Options }

func (*ytdlpExtractor) handles(*url.URL) bool { return true }

func (e *ytdlpExtractor) probeDuration(ctx context.Context, rawURL string) (int64, bool) {
	args := []string{"--no-playlist", "--skip-download", "--print", "duration"}
	args = append(args, e.proxyArgs()...)
	args = append(args, "--", rawURL)
	out, err := e.opts.Runner(ctx, e.opts.Bin, args...)
	if err != nil {
		return 0, false
	}
	s := strings.TrimSpace(string(out))
	// yt-dlp prints a float for some extractors ("123.0").
	if f, err := strconv.ParseFloat(s, 64); err == nil {
		return int64(f), true
	}
	return 0, false
}

func (e *ytdlpExtractor) download(ctx context.Context, rawURL, destDir string, onProgress func(int)) (string, error) {
	tmpl := filepath.Join(destDir, "audio.%(ext)s")
	// --concurrent-fragments parallelizes the per-fragment fetches of a DASH/HLS
	// audio stream. Each fragment is a round-trip through the (slow) residential
	// proxy, so fetching several at once is the biggest lever on download time.
	args := []string{"-x", "--audio-format", "mp3", "--no-playlist", "--concurrent-fragments", "4", "-o", tmpl}
	if e.opts.MaxBytes > 0 {
		args = append(args, "--max-filesize", strconv.FormatInt(e.opts.MaxBytes, 10))
	}
	args = append(args, e.proxyArgs()...)
	args = append(args, "--", rawURL)

	// Stream the download to report live percent when a progress sink is wired
	// (production). A test with no ProgressRunner, or a caller passing no sink,
	// falls back to the buffered Runner — identical behaviour, just no percent.
	if e.opts.ProgressRunner != nil && onProgress != nil {
		streamArgs := append([]string{"--newline", "--progress-template", progressTemplate}, args...)
		onLine := func(line string) {
			if pct, ok := parsePercent(line); ok {
				onProgress(pct)
			}
		}
		if err := e.opts.ProgressRunner(ctx, onLine, e.opts.Bin, streamArgs...); err != nil {
			return "", classifyDownloadErr(err)
		}
		return findAudio(destDir)
	}

	if _, err := e.opts.Runner(ctx, e.opts.Bin, args...); err != nil {
		return "", classifyDownloadErr(err)
	}
	return findAudio(destDir)
}

func (e *ytdlpExtractor) proxyArgs() []string {
	if e.opts.Proxy == "" {
		return nil
	}
	return []string{"--proxy", e.opts.Proxy}
}

// findAudio locates the extracted audio file in destDir (yt-dlp writes
// audio.mp3, but the container may differ if conversion was skipped).
func findAudio(destDir string) (string, error) {
	entries, err := os.ReadDir(destDir)
	if err != nil {
		return "", err
	}
	for _, en := range entries {
		if !en.IsDir() && strings.HasPrefix(en.Name(), "audio.") {
			return filepath.Join(destDir, en.Name()), nil
		}
	}
	return "", fmt.Errorf("yt-dlp: no audio artifact in %s", destDir)
}

// progressWriter counts bytes written and reports the running download percent.
// It only forwards when the whole-number percent advances, so a large body
// yields at most 100 callbacks (the worker throttles further).
type progressWriter struct {
	total     int64
	written   int64
	last      int
	onPercent func(int)
}

func (w *progressWriter) Write(p []byte) (int, error) {
	n := len(p)
	w.written += int64(n)
	pct := int(w.written * 100 / w.total)
	if pct > 100 {
		pct = 100
	}
	if pct > w.last {
		w.last = pct
		w.onPercent(pct)
	}
	return n, nil
}

// --- direct-mp3 extractor ---

type mp3Extractor struct{ opts *Options }

func (*mp3Extractor) handles(u *url.URL) bool {
	return strings.HasSuffix(strings.ToLower(u.Path), ".mp3")
}

// probeDuration is not cheap for a bare file; skip it (size limit still applies).
func (*mp3Extractor) probeDuration(context.Context, string) (int64, bool) { return 0, false }

func (e *mp3Extractor) download(ctx context.Context, rawURL, destDir string, onProgress func(int)) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return "", err
	}
	resp, err := e.opts.HTTPClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("mp3 fetch: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		// 4xx is a permanent client error (gone / forbidden / not found); 5xx and
		// the rest are transient and worth a retry.
		if resp.StatusCode >= 400 && resp.StatusCode < 500 {
			return "", fmt.Errorf("mp3 fetch: status %d: %w", resp.StatusCode, ingest.ErrPermanent)
		}
		return "", fmt.Errorf("mp3 fetch: status %d", resp.StatusCode)
	}
	path := filepath.Join(destDir, "audio.mp3")
	out, err := os.Create(path)
	if err != nil {
		return "", err
	}
	defer out.Close()

	var reader io.Reader = resp.Body
	if e.opts.MaxBytes > 0 {
		// Read one extra byte so an over-limit body is detected, not silently
		// truncated.
		reader = io.LimitReader(resp.Body, e.opts.MaxBytes+1)
	}
	// Report percent against Content-Length when the server advertises it — a
	// bare stream (no length) simply reports no progress.
	var writer io.Writer = out
	if onProgress != nil && resp.ContentLength > 0 {
		writer = io.MultiWriter(out, &progressWriter{total: resp.ContentLength, onPercent: onProgress})
	}
	n, err := io.Copy(writer, reader)
	if err != nil {
		return "", fmt.Errorf("mp3 write: %w", err)
	}
	if e.opts.MaxBytes > 0 && n > e.opts.MaxBytes {
		return "", fmt.Errorf("mp3 fetch: body exceeds limit %d: %w", e.opts.MaxBytes, ingest.ErrPermanent)
	}
	return path, nil
}
