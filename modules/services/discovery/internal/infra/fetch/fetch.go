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
	"sync"
	"time"

	"github.com/jiva-studio/shruti/discovery/internal/domain"
	"github.com/hashicorp/go-retryablehttp"
	"golang.org/x/time/rate"
)

var (
	ErrDisallowed   = domain.ErrDisallowed
	ErrRobotsUnread = domain.ErrRobotsUnread
	ErrCircuitOpen  = domain.ErrCircuitOpen
	ErrTooLarge     = domain.ErrTooLarge
	ErrGone         = domain.ErrGone
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
	// Readers are the external readers a source may name. Each says what it is
	// called; a source picks one by that name in Request.Tool.
	Readers []Reader
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

// Reader reads an address some other way than an HTTP request: a subprocess, a
// headless browser, a site's own client. Adding one is writing this interface
// and naming it in the config — the crawl above and the politeness below both
// stay as they are.
//
// A reader is called from Get, after the host's turn has come round and inside
// the same breaker, so one that spawns a process is no less polite than one
// that opens a socket. The gap between requests is what bounds how hard a host
// is leaned on, and nothing may slip past it.
//
// An address that holds nothing any more is an error wrapping ErrGone. That is
// the reader's 404: the state of one page, not of the host, and the breaker
// must not count it against the site.
// Reader reads an address some other way than an HTTP request.
type Reader = domain.Reader

// Reading is what a reader hands back.
type Reading = domain.Reading

// Request is what to ask for.
type Request = domain.FetchRequest

// Response is one fetched page.
type Response = domain.FetchResponse

// Client fetches pages politely. It is safe for concurrent use.
type Client struct {
	cfg     Config
	http    *retryablehttp.Client
	robots  *robotsCache
	readers map[string]Reader

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

	readers := make(map[string]Reader, len(cfg.Readers))
	for _, r := range cfg.Readers {
		readers[r.Name()] = r
	}
	return &Client{
		cfg:     cfg,
		http:    rc,
		robots:  newRobotsCache(cfg.UserAgent),
		readers: readers,
		hosts:   map[string]*hostState{},
	}
}

// Allowed reports whether robots.txt lets us fetch this address, without
// fetching it. Rules are per host and already in memory, so asking before
// queueing an address costs nothing after the first read of a host.
//
// A host that has not told us its rules gets the benefit of the doubt here.
// Get will refuse anyway, and refusing there says why; refusing here would
// empty the queue silently.
func (c *Client) Allowed(ctx context.Context, rawURL string) bool {
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return false
	}
	rules := c.robots.get(ctx, u)
	return !rules.known() || rules.allows(u.RequestURI())
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
	if !rules.known() {
		return nil, ErrRobotsUnread
	}
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

	var resp *Response
	if req.Tool != "" {
		resp, err = c.read(ctx, req.Tool, rawURL, req)
	} else {
		resp, err = c.do(ctx, rawURL, req)
	}
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

func errStatus(code int) error { return fmt.Errorf("http %d", code) }

// read hands one address to the reader the source named, and turns what comes
// back into an ordinary response so nothing above here has to know that a
// subprocess was involved.
func (c *Client) read(ctx context.Context, name, rawURL string, req Request) (*Response, error) {
	reader, ok := c.readers[name]
	if !ok {
		return nil, fmt.Errorf("fetch: no reader named %q", name)
	}
	out, err := reader.Read(ctx, rawURL, req.Headers)
	if err != nil {
		// The reader's 404 comes back as one, so the breaker sees a page that
		// is missing rather than a host that is failing.
		if errors.Is(err, ErrGone) {
			return &Response{URL: rawURL, Status: http.StatusNotFound}, err
		}
		return nil, err
	}
	if int64(len(out.Body)) > c.cfg.MaxBody {
		return nil, ErrTooLarge
	}
	sum := sha256.Sum256(out.Body)
	return &Response{
		URL:         rawURL,
		Status:      http.StatusOK,
		Body:        out.Body,
		BodySHA256:  hex.EncodeToString(sum[:]),
		ContentType: out.ContentType,
	}, nil
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


// Kind names why a fetch did not produce a page, in the words the run summaries
// and the counters both use. It lives here because these are this package's own
// refusals, and two callers naming them differently would make a tally that
// cannot be added up.
func Kind(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, ErrDisallowed):
		return "disallowed"
	case errors.Is(err, ErrRobotsUnread):
		return "robots_unread"
	case errors.Is(err, ErrCircuitOpen):
		return "circuit_open"
	case errors.Is(err, ErrGone):
		return "gone"
	case errors.Is(err, ErrTooLarge):
		return "too_large"
	default:
		return "fetch_failed"
	}
}
