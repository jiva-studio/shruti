// Package fetch is the polite outbound HTTP client.
//
// Transport, retries and robots parsing come from libraries. What is ours is
// the part that spans runs and lives in our database: the conditional GET
// against validators we stored last time, so a recheck of an unchanged page
// costs one request and no body.
//
// The sites indexed here are volunteer archives paying their own bandwidth
// bills. Every request identifies us and says where to complain.
package fetch

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/hashicorp/go-retryablehttp"
	"golang.org/x/time/rate"
)

var (
	// ErrDisallowed means robots.txt forbids this path.
	ErrDisallowed = errors.New("fetch: disallowed by robots.txt")
	// ErrCircuitOpen means this host has failed repeatedly and is cooling down.
	ErrCircuitOpen = errors.New("fetch: circuit breaker open")
	// ErrTooLarge means the response exceeded the body cap.
	ErrTooLarge = errors.New("fetch: response too large")
)

// Config is what the client needs to behave.
type Config struct {
	// UserAgent names us and carries a contact URL.
	UserAgent string
	// DefaultDelay is the gap between requests to one host when robots.txt
	// states no crawl-delay of its own.
	DefaultDelay time.Duration
	// Timeout bounds one request.
	Timeout time.Duration
	// MaxBody caps how much of a response we will read.
	MaxBody int64
	// RetryMax is how many times a 429 or 5xx is retried, honouring Retry-After.
	RetryMax int
	// RetryWaitMin and RetryWaitMax bound the backoff between those retries.
	RetryWaitMin time.Duration
	RetryWaitMax time.Duration
}

func (c *Config) withDefaults() {
	if c.UserAgent == "" {
		c.UserAgent = "ShrutiDiscovery/1.0"
	}
	if c.DefaultDelay <= 0 {
		c.DefaultDelay = time.Second
	}
	if c.Timeout <= 0 {
		c.Timeout = 30 * time.Second
	}
	if c.MaxBody <= 0 {
		c.MaxBody = 8 << 20
	}
	if c.RetryMax <= 0 {
		c.RetryMax = 3
	}
	if c.RetryWaitMin <= 0 {
		c.RetryWaitMin = time.Second
	}
	if c.RetryWaitMax <= 0 {
		c.RetryWaitMax = 30 * time.Second
	}
}

// Request is what to ask for: the validators stored from the last fetch of this
// URL, plus any headers the source needs to answer at all.
type Request struct {
	ETag         string
	LastModified string
	// Headers are the source's credentials — a session cookie, a bearer token,
	// an API key. Sent verbatim, so no scheme needs to be understood here.
	Headers map[string]string
	// MinDelay is the source's own politeness setting. The gap actually used
	// is the largest of this, the service default, and whatever robots.txt
	// asked for — a source can be told to go gently, never to go faster.
	MinDelay time.Duration
}

// Response is one fetched page.
type Response struct {
	// URL is where we ended up, which is not where we asked if the host
	// redirected.
	URL          string
	Status       int
	NotModified  bool
	Body         []byte
	BodySHA256   string
	ContentType  string
	ETag         string
	LastModified string
}

// Client fetches pages politely. It is safe for concurrent use.
type Client struct {
	cfg    Config
	http   *retryablehttp.Client
	robots *robotsCache

	mu    sync.Mutex
	hosts map[string]*hostState
}

// hostState is the per-host scheduling we impose on top of the transport.
type hostState struct {
	limiter *rate.Limiter
	breaker *breaker
	delay   time.Duration
}

func New(cfg Config) *Client {
	cfg.withDefaults()

	rc := retryablehttp.NewClient()
	rc.RetryMax = cfg.RetryMax
	rc.RetryWaitMin = cfg.RetryWaitMin
	rc.RetryWaitMax = cfg.RetryWaitMax
	rc.Logger = nil
	rc.HTTPClient = &http.Client{Timeout: cfg.Timeout}

	return &Client{
		cfg:    cfg,
		http:   rc,
		robots: newRobotsCache(cfg.UserAgent),
		hosts:  map[string]*hostState{},
	}
}

// Get fetches one URL, waiting its turn on this host and skipping the body
// entirely when the page has not changed since cond was recorded.
func (c *Client) Get(ctx context.Context, rawURL string, req Request) (*Response, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("parse url: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return nil, fmt.Errorf("unsupported scheme %q", u.Scheme)
	}

	rules := c.robots.get(ctx, u)
	if !rules.allows(u.RequestURI()) {
		return nil, ErrDisallowed
	}

	host := c.hostState(u.Host, max(rules.crawlDelay(), req.MinDelay))
	if !host.breaker.allow() {
		return nil, ErrCircuitOpen
	}
	if err := host.limiter.Wait(ctx); err != nil {
		return nil, err
	}

	resp, err := c.do(ctx, rawURL, req)
	if host.breaker.record(hostHealthy(resp, err)) {
		slog.WarnContext(ctx, "host_circuit_opened",
			"host", u.Host, "cooldown", host.breaker.cooldown.String(),
			"last_error", errText(err))
	}
	return resp, err
}

// hostHealthy says whether an outcome is the host's fault.
//
// A page that is missing or malformed is not a failing host, and five dead
// links in a row should not stop us visiting a site that is answering fine.
// Being refused is different: a single 403 is a page we may not read, but five
// in a row is the site declining to talk to us, and the consecutive-failure
// count is what tells those apart.
func hostHealthy(resp *Response, err error) bool {
	if err == nil {
		return true
	}
	// A body bigger than our cap is our limit, not the host misbehaving.
	if errors.Is(err, ErrTooLarge) {
		return true
	}
	if resp == nil {
		return false // transport failure: timeout, connection refused, DNS
	}
	switch {
	case resp.Status >= 500, resp.Status == http.StatusTooManyRequests:
		return false
	case resp.Status == http.StatusUnauthorized,
		resp.Status == http.StatusForbidden,
		resp.Status == http.StatusUnavailableForLegalReasons:
		return false
	default:
		return true // 404, 410, 400 and friends: this page, not this host
	}
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func (c *Client) do(ctx context.Context, rawURL string, want Request) (*Response, error) {
	req, err := retryablehttp.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return nil, err
	}
	// Accept-Encoding is left to the transport: setting it by hand turns off
	// Go's transparent decompression and hands back raw gzip bytes.
	req.Header.Set("User-Agent", c.cfg.UserAgent)
	for name, value := range want.Headers {
		req.Header.Set(name, value)
	}
	if want.ETag != "" {
		req.Header.Set("If-None-Match", want.ETag)
	}
	if want.LastModified != "" {
		req.Header.Set("If-Modified-Since", want.LastModified)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	out := &Response{
		URL:          resp.Request.URL.String(),
		Status:       resp.StatusCode,
		ContentType:  resp.Header.Get("Content-Type"),
		ETag:         resp.Header.Get("ETag"),
		LastModified: resp.Header.Get("Last-Modified"),
	}
	if resp.StatusCode == http.StatusNotModified {
		out.NotModified = true
		return out, nil
	}
	if resp.StatusCode >= 400 {
		return out, fmt.Errorf("http %d", resp.StatusCode)
	}

	// Read one byte past the cap so an oversized body is an error rather than a
	// silent truncation that would look like a changed page.
	body, err := io.ReadAll(io.LimitReader(resp.Body, c.cfg.MaxBody+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > c.cfg.MaxBody {
		return nil, ErrTooLarge
	}
	sum := sha256.Sum256(body)
	out.Body = body
	out.BodySHA256 = hex.EncodeToString(sum[:])
	return out, nil
}

// hostState returns this host's limiter and breaker, creating them on first
// sight and adopting the crawl-delay robots.txt asked for.
func (c *Client) hostState(host string, robotsDelay time.Duration) *hostState {
	delay := c.cfg.DefaultDelay
	if robotsDelay > delay {
		delay = robotsDelay
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	if h, ok := c.hosts[host]; ok {
		if h.delay != delay {
			h.delay = delay
			h.limiter.SetLimit(rate.Every(delay))
		}
		return h
	}
	h := &hostState{
		limiter: rate.NewLimiter(rate.Every(delay), 1),
		breaker: newBreaker(5, 5*time.Minute),
		delay:   delay,
	}
	c.hosts[host] = h
	return h
}

// IsHTML reports whether a response carries markup rather than a media file.
func (r *Response) IsHTML() bool {
	ct := strings.ToLower(r.ContentType)
	return strings.Contains(ct, "html") || strings.Contains(ct, "xml")
}
