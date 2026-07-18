// Package ytdlp implements ports.Fetcher by shelling out to yt-dlp (the same
// tool services/share-video's background pipeline uses). It routes a URL to an
// extractor via a domain registry (yt-dlp for arbitrary sites, a direct HTTP
// path for bare .mp3 links), enforces input limits (max source duration and
// max downloaded bytes), guards the upstream with a circuit breaker, and
// content-addresses the downloaded bytes into the track_id.
package ytdlp

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/jiva-studio/shruti/orchestrator/internal/domain/ingest"
)

// Runner executes an external command and returns its combined stdout. Injected
// so the extractor logic can be unit-tested without a real yt-dlp binary.
type Runner func(ctx context.Context, name string, args ...string) ([]byte, error)

func execRunner(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).Output()
}

// Options configure the Fetcher.
type Options struct {
	Bin          string        // yt-dlp binary (default "yt-dlp")
	Proxy        string        // host-only proxy passed to --proxy (empty = none)
	MaxBytes     int64         // reject artifacts larger than this (0 = unlimited)
	MaxSeconds   int64         // reject sources longer than this (0 = unlimited)
	WorkDir      string        // parent dir for per-fetch temp dirs (default os.TempDir)
	BreakerN     int           // consecutive failures before the breaker opens
	BreakerCool  time.Duration // breaker cooldown
	Runner       Runner        // command runner (default exec)
	HTTPClient   *http.Client  // client for the direct-mp3 extractor
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
	if opts.HTTPClient == nil {
		opts.HTTPClient = &http.Client{Timeout: 10 * time.Minute}
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
// the content hash (track_id).
func (f *Fetcher) Fetch(ctx context.Context, rawURL string) (string, string, error) {
	if !f.breaker.allow() {
		return "", "", ErrCircuitOpen
	}
	localPath, hash, err := f.fetch(ctx, rawURL)
	f.breaker.record(err == nil)
	return localPath, hash, err
}

func (f *Fetcher) fetch(ctx context.Context, rawURL string) (string, string, error) {
	u, err := url.Parse(rawURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", "", fmt.Errorf("fetch: invalid url %q", rawURL)
	}
	ext := f.reg.pick(u)

	// Enforce the duration limit BEFORE downloading when the extractor can
	// probe it cheaply.
	if f.opts.MaxSeconds > 0 {
		if dur, ok := ext.probeDuration(ctx, rawURL); ok && dur > f.opts.MaxSeconds {
			return "", "", fmt.Errorf("fetch: source duration %ds exceeds limit %ds", dur, f.opts.MaxSeconds)
		}
	}

	dir, err := os.MkdirTemp(f.opts.WorkDir, "ingest-*")
	if err != nil {
		return "", "", fmt.Errorf("fetch: tempdir: %w", err)
	}
	path, err := ext.download(ctx, rawURL, dir)
	if err != nil {
		_ = os.RemoveAll(dir)
		return "", "", err
	}

	fi, err := os.Stat(path)
	if err != nil {
		_ = os.RemoveAll(dir)
		return "", "", fmt.Errorf("fetch: stat: %w", err)
	}
	if f.opts.MaxBytes > 0 && fi.Size() > f.opts.MaxBytes {
		_ = os.RemoveAll(dir)
		return "", "", fmt.Errorf("fetch: artifact %d bytes exceeds limit %d", fi.Size(), f.opts.MaxBytes)
	}

	b, err := os.ReadFile(path)
	if err != nil {
		_ = os.RemoveAll(dir)
		return "", "", fmt.Errorf("fetch: read artifact: %w", err)
	}
	return path, ingest.ContentID(b), nil
}

// --- extractor registry ---

// extractor downloads a URL to a local file and can probe its duration.
type extractor interface {
	// handles reports whether this extractor claims the URL.
	handles(u *url.URL) bool
	download(ctx context.Context, rawURL, destDir string) (string, error)
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
	args = append(args, rawURL)
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

func (e *ytdlpExtractor) download(ctx context.Context, rawURL, destDir string) (string, error) {
	tmpl := filepath.Join(destDir, "audio.%(ext)s")
	args := []string{"-x", "--audio-format", "mp3", "--no-playlist", "-o", tmpl}
	if e.opts.MaxBytes > 0 {
		args = append(args, "--max-filesize", strconv.FormatInt(e.opts.MaxBytes, 10))
	}
	args = append(args, e.proxyArgs()...)
	args = append(args, rawURL)
	if _, err := e.opts.Runner(ctx, e.opts.Bin, args...); err != nil {
		return "", fmt.Errorf("yt-dlp: %w", err)
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

// --- direct-mp3 extractor ---

type mp3Extractor struct{ opts *Options }

func (*mp3Extractor) handles(u *url.URL) bool {
	return strings.HasSuffix(strings.ToLower(u.Path), ".mp3")
}

// probeDuration is not cheap for a bare file; skip it (size limit still applies).
func (*mp3Extractor) probeDuration(context.Context, string) (int64, bool) { return 0, false }

func (e *mp3Extractor) download(ctx context.Context, rawURL, destDir string) (string, error) {
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
	n, err := io.Copy(out, reader)
	if err != nil {
		return "", fmt.Errorf("mp3 write: %w", err)
	}
	if e.opts.MaxBytes > 0 && n > e.opts.MaxBytes {
		return "", fmt.Errorf("mp3 fetch: body exceeds limit %d", e.opts.MaxBytes)
	}
	return path, nil
}
