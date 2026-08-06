package fetch_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jiva-studio/lectorium/discovery/internal/infra/fetch"
)

// testClient is fast enough to run in a unit test and still exercises the real
// limiter, breaker and retry paths.
func testClient(t *testing.T) *fetch.Client {
	t.Helper()
	return fetch.New(fetch.Config{
		UserAgent:    "LectoriumDiscoveryTest/1.0 (+https://example.org/about)",
		DefaultDelay: time.Millisecond,
		Timeout:      5 * time.Second,
		MaxBody:      1 << 20,
		RetryMax:     2,
		RetryWaitMin: time.Millisecond,
		RetryWaitMax: 5 * time.Millisecond,
	})
}

// server routes /robots.txt to robots and everything else to page.
func server(t *testing.T, robots func(http.ResponseWriter, *http.Request), page http.HandlerFunc) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/robots.txt" {
			robots(w, r)
			return
		}
		page(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func robotsAllowAll(w http.ResponseWriter, _ *http.Request) {
	_, _ = w.Write([]byte("User-agent: *\nAllow: /\n"))
}

func TestFetchesWhenAllowed(t *testing.T) {
	srv := server(t, robotsAllowAll, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Header().Set("ETag", `"v1"`)
		_, _ = w.Write([]byte("<html><body>hello</body></html>"))
	})

	resp, err := testClient(t).Get(context.Background(), srv.URL+"/page", fetch.Request{})
	if err != nil {
		t.Fatal(err)
	}
	if resp.Status != 200 || !strings.Contains(string(resp.Body), "hello") {
		t.Fatalf("status=%d body=%q", resp.Status, resp.Body)
	}
	if resp.ETag != `"v1"` || resp.BodySHA256 == "" {
		t.Errorf("etag=%q sha=%q", resp.ETag, resp.BodySHA256)
	}
	if !resp.IsHTML() {
		t.Errorf("content type %q not recognised as markup", resp.ContentType)
	}
}

func TestRobotsDisallow(t *testing.T) {
	srv := server(t, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("User-agent: *\nDisallow: /private/\n"))
	}, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("secret"))
	})

	c := testClient(t)
	if _, err := c.Get(context.Background(), srv.URL+"/private/x", fetch.Request{}); !errors.Is(err, fetch.ErrDisallowed) {
		t.Fatalf("err = %v, want ErrDisallowed", err)
	}
	if _, err := c.Get(context.Background(), srv.URL+"/public/x", fetch.Request{}); err != nil {
		t.Fatalf("allowed path: %v", err)
	}
}

// A host with no robots.txt has no rules, so everything is allowed.
func TestRobotsMissingMeansAllowed(t *testing.T) {
	srv := server(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNotFound)
	}, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})

	if _, err := testClient(t).Get(context.Background(), srv.URL+"/a", fetch.Request{}); err != nil {
		t.Fatalf("404 robots must allow: %v", err)
	}
}

// A host that cannot serve its own robots.txt has not given permission — and
// has not refused either, which is a different thing and must read as one.
func TestRobotsServerErrorIsNotARefusal(t *testing.T) {
	srv := server(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})

	_, err := testClient(t).Get(context.Background(), srv.URL+"/a", fetch.Request{})
	if !errors.Is(err, fetch.ErrRobotsUnread) {
		t.Fatalf("err = %v, want ErrRobotsUnread", err)
	}
	if errors.Is(err, fetch.ErrDisallowed) {
		t.Error("a host having a bad day must not read as a host refusing us")
	}
}

// The bug this guards: one bad minute on robots.txt used to drop a host out of
// the crawl for a whole day, silently, and looking exactly like a refusal.
func TestRobotsRecoversAfterOneBadFetch(t *testing.T) {
	var attempts int
	srv := server(t, func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if attempts == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		robotsAllowAll(w, r)
	}, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})

	c := testClient(t)
	if _, err := c.Get(context.Background(), srv.URL+"/a", fetch.Request{}); !errors.Is(err, fetch.ErrRobotsUnread) {
		t.Fatalf("first fetch: err = %v, want ErrRobotsUnread", err)
	}
	fetch.ExpireRobots(c)
	if _, err := c.Get(context.Background(), srv.URL+"/a", fetch.Request{}); err != nil {
		t.Fatalf("the host is answering again: %v", err)
	}
}

// Rules that were actually read are read once, however many workers start
// together: robots.txt is the one file a crawler must not hammer.
func TestRobotsReadOncePerHost(t *testing.T) {
	var mu sync.Mutex
	var reads int
	srv := server(t, func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		reads++
		mu.Unlock()
		robotsAllowAll(w, r)
	}, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})

	c := testClient(t)
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = c.Get(context.Background(), srv.URL+"/a", fetch.Request{})
		}()
	}
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()
	if reads != 1 {
		t.Errorf("robots.txt read %d times for one host, want 1", reads)
	}
}

// A run we stopped ourselves says nothing about the host, and must not be
// remembered as if it did.
func TestCancelledRobotsFetchIsNotRemembered(t *testing.T) {
	srv := server(t, robotsAllowAll, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})

	c := testClient(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := c.Get(ctx, srv.URL+"/a", fetch.Request{}); err == nil {
		t.Fatal("a cancelled context must not fetch")
	}
	if _, err := c.Get(context.Background(), srv.URL+"/a", fetch.Request{}); err != nil {
		t.Fatalf("the next run must start clean: %v", err)
	}
}

// The stored validators go out and a 304 comes back with no body — the whole
// point of keeping them.
func TestConditionalGet(t *testing.T) {
	var gotETag, gotSince string
	srv := server(t, robotsAllowAll, func(w http.ResponseWriter, r *http.Request) {
		gotETag = r.Header.Get("If-None-Match")
		gotSince = r.Header.Get("If-Modified-Since")
		w.WriteHeader(http.StatusNotModified)
	})

	resp, err := testClient(t).Get(context.Background(), srv.URL+"/page", fetch.Request{
		ETag:         `"v1"`,
		LastModified: "Wed, 21 Oct 2015 07:28:00 GMT",
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotETag != `"v1"` || gotSince == "" {
		t.Errorf("validators not sent: etag=%q since=%q", gotETag, gotSince)
	}
	if !resp.NotModified || len(resp.Body) != 0 {
		t.Errorf("not-modified=%v body=%d bytes", resp.NotModified, len(resp.Body))
	}
}

func TestRetriesRateLimit(t *testing.T) {
	var hits int
	srv := server(t, robotsAllowAll, func(w http.ResponseWriter, _ *http.Request) {
		hits++
		if hits == 1 {
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		_, _ = w.Write([]byte("ok"))
	})

	resp, err := testClient(t).Get(context.Background(), srv.URL+"/page", fetch.Request{})
	if err != nil {
		t.Fatal(err)
	}
	if resp.Status != 200 || hits != 2 {
		t.Errorf("status=%d hits=%d, want 200 after one retry", resp.Status, hits)
	}
}

func TestBodyCap(t *testing.T) {
	srv := server(t, robotsAllowAll, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("x", 4096)))
	})

	c := fetch.New(fetch.Config{
		DefaultDelay: time.Millisecond,
		MaxBody:      1024,
		RetryWaitMin: time.Millisecond,
		RetryWaitMax: 5 * time.Millisecond,
	})
	if _, err := c.Get(context.Background(), srv.URL+"/big", fetch.Request{}); !errors.Is(err, fetch.ErrTooLarge) {
		t.Fatalf("err = %v, want ErrTooLarge", err)
	}
}

// A host that keeps failing is left alone until it has had a rest.
func TestBreakerOpens(t *testing.T) {
	srv := server(t, robotsAllowAll, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})

	c := fetch.New(fetch.Config{
		DefaultDelay: time.Millisecond,
		RetryMax:     0,
		RetryWaitMin: time.Millisecond,
		RetryWaitMax: 5 * time.Millisecond,
	})
	var last error
	for range 6 {
		_, last = c.Get(context.Background(), srv.URL+"/a", fetch.Request{})
	}
	if !errors.Is(last, fetch.ErrCircuitOpen) {
		t.Fatalf("err = %v, want ErrCircuitOpen after repeated failures", last)
	}
}

// The UA has to say who we are and where to complain, on every request.
func TestUserAgentIdentifiesUs(t *testing.T) {
	var ua, robotsUA string
	srv := server(t, func(w http.ResponseWriter, r *http.Request) {
		robotsUA = r.Header.Get("User-Agent")
		robotsAllowAll(w, r)
	}, func(w http.ResponseWriter, r *http.Request) {
		ua = r.Header.Get("User-Agent")
		_, _ = w.Write([]byte("ok"))
	})

	if _, err := testClient(t).Get(context.Background(), srv.URL+"/a", fetch.Request{}); err != nil {
		t.Fatal(err)
	}
	for _, got := range []string{ua, robotsUA} {
		if !strings.Contains(got, "LectoriumDiscovery") || !strings.Contains(got, "http") {
			t.Errorf("user agent %q must name us and carry a contact URL", got)
		}
	}
}

// A source's credentials go out with every request, alongside the validators
// and without displacing them.
func TestSourceHeaders(t *testing.T) {
	var gotCookie, gotAuth, gotUA, gotETag string
	srv := server(t, robotsAllowAll, func(w http.ResponseWriter, r *http.Request) {
		gotCookie, gotAuth = r.Header.Get("Cookie"), r.Header.Get("Authorization")
		gotUA, gotETag = r.Header.Get("User-Agent"), r.Header.Get("If-None-Match")
		_, _ = w.Write([]byte("ok"))
	})

	_, err := testClient(t).Get(context.Background(), srv.URL+"/gated", fetch.Request{
		ETag:    `"v1"`,
		Headers: map[string]string{"Cookie": "session=abc", "Authorization": "Bearer xyz"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotCookie != "session=abc" || gotAuth != "Bearer xyz" {
		t.Errorf("cookie=%q authorization=%q", gotCookie, gotAuth)
	}
	if gotETag != `"v1"` {
		t.Errorf("credentials displaced the validator: if-none-match=%q", gotETag)
	}
	if !strings.Contains(gotUA, "LectoriumDiscovery") {
		t.Errorf("user agent = %q", gotUA)
	}
}

// A missing page is not a failing host. Five dead links in a row must not stop
// us visiting a site that is answering perfectly well.
func TestMissingPagesDoNotOpenTheBreaker(t *testing.T) {
	srv := server(t, robotsAllowAll, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/alive" {
			_, _ = w.Write([]byte("ok"))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})

	c := testClient(t)
	for range 8 {
		_, _ = c.Get(context.Background(), srv.URL+"/gone", fetch.Request{})
	}
	if _, err := c.Get(context.Background(), srv.URL+"/alive", fetch.Request{}); err != nil {
		t.Fatalf("a live page after eight 404s: %v", err)
	}
}

// Being refused is different: one 403 is a page we may not read, five in a row
// is the site declining to talk to us.
func TestRefusalOpensTheBreaker(t *testing.T) {
	srv := server(t, robotsAllowAll, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	})

	c := testClient(t)
	var last error
	for range 6 {
		_, last = c.Get(context.Background(), srv.URL+"/x", fetch.Request{})
	}
	if !errors.Is(last, fetch.ErrCircuitOpen) {
		t.Fatalf("err = %v, want ErrCircuitOpen", last)
	}
}

// A source may ask to be crawled more slowly than the service default, and
// never faster.
func TestSourceCanAskForAWiderGap(t *testing.T) {
	srv := server(t, robotsAllowAll, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("ok"))
	})

	c := fetch.New(fetch.Config{
		UserAgent: "T/1 (+http://x)", DefaultDelay: time.Millisecond,
		RetryWaitMin: time.Millisecond, RetryWaitMax: 2 * time.Millisecond,
	})
	req := fetch.Request{MinDelay: 150 * time.Millisecond}

	start := time.Now()
	for range 3 {
		if _, err := c.Get(context.Background(), srv.URL+"/a", req); err != nil {
			t.Fatal(err)
		}
	}
	if elapsed := time.Since(start); elapsed < 250*time.Millisecond {
		t.Errorf("three requests took %v; the source asked for 150ms between them", elapsed)
	}
}

// A page bigger than our cap is our limit, not a failing host. Counting it
// against the host opened the breaker on a run of oversized files and stopped
// a crawl that the site was answering perfectly well.
func TestOversizedBodyDoesNotOpenBreaker(t *testing.T) {
	srv := server(t, robotsAllowAll, func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("x", 4096)))
	})

	c := fetch.New(fetch.Config{
		DefaultDelay: time.Millisecond,
		MaxBody:      1024,
		RetryMax:     0,
		RetryWaitMin: time.Millisecond,
		RetryWaitMax: 5 * time.Millisecond,
	})
	var last error
	for range 6 {
		_, last = c.Get(context.Background(), srv.URL+"/big", fetch.Request{})
	}
	if !errors.Is(last, fetch.ErrTooLarge) {
		t.Fatalf("err = %v, want ErrTooLarge and an unbroken circuit", last)
	}
}
