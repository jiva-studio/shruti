package gemini

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func client(t *testing.T, h http.HandlerFunc) *Client {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	c, err := New(Options{Endpoint: srv.URL, APIKey: "k", Model: "gemini-flash-lite-latest"})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestSubmitSendsKeysAndPrompts(t *testing.T) {
	var seen map[string]any
	c := client(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-goog-api-key") != "k" {
			t.Errorf("api key header = %q", r.Header.Get("X-goog-api-key"))
		}
		if !strings.HasSuffix(r.URL.Path, "/models/gemini-flash-lite-latest:batchGenerateContent") {
			t.Errorf("path = %q", r.URL.Path)
		}
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &seen)
		if strings.Contains(string(raw), "thinkingConfig") {
			t.Error("thinkingConfig must not be sent — the model rejects it")
		}
		_, _ = w.Write([]byte(`{"name":"batches/abc"}`))
	})

	name, err := c.Submit(t.Context(), "probe", []Request{
		{Key: "track_a:0", System: "sys", User: "u0", Temperature: 0.1, MaxTokens: 8192},
		{Key: "track_b:3", System: "sys", User: "u1", Temperature: 0.1, MaxTokens: 8192},
	})
	if err != nil {
		t.Fatal(err)
	}
	if name != "batches/abc" {
		t.Errorf("name = %q", name)
	}
	items := seen["batch"].(map[string]any)["inputConfig"].(map[string]any)["requests"].(map[string]any)["requests"].([]any)
	if len(items) != 2 {
		t.Fatalf("sent %d items, want 2", len(items))
	}
	first := items[0].(map[string]any)
	if k := first["metadata"].(map[string]any)["key"]; k != "track_a:0" {
		t.Errorf("key = %v", k)
	}
	req := first["request"].(map[string]any)
	if req["systemInstruction"] == nil {
		t.Error("systemInstruction missing")
	}
}

func TestSubmitRejectsDuplicateAndEmptyKeys(t *testing.T) {
	c := client(t, func(w http.ResponseWriter, r *http.Request) {
		t.Error("must not reach the network")
	})
	for _, tc := range []struct {
		name, want string
		reqs       []Request
	}{
		{"empty key", "without a key", []Request{{Key: "", User: "u"}}},
		{"duplicate", "duplicate key", []Request{{Key: "a", User: "u"}, {Key: "a", User: "u"}}},
		{"nothing", "no requests", nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := c.Submit(t.Context(), "d", tc.reqs); err == nil ||
				!strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want it to mention %q", err, tc.want)
			}
		})
	}
}

func TestStatusParsesStringCounts(t *testing.T) {
	c := client(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"name":"batches/abc","metadata":{"state":"BATCH_STATE_RUNNING",
			"batchStats":{"requestCount":"27","pendingRequestCount":"27"}}}`))
	})
	job, err := c.Status(t.Context(), "batches/abc")
	if err != nil {
		t.Fatal(err)
	}
	if job.State != StateRunning || job.State.Done() {
		t.Errorf("state = %q, done = %v", job.State, job.State.Done())
	}
	if job.Stats.Total != 27 || job.Stats.Pending != 27 {
		t.Errorf("stats = %+v", job.Stats)
	}
}

// A job reports SUCCEEDED even when every request inside it failed, so the
// caller has to look at the per-request errors rather than the state.
func TestFetchSurfacesPerRequestFailures(t *testing.T) {
	c := client(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"name":"batches/abc","done":true,"metadata":{
			"state":"BATCH_STATE_SUCCEEDED",
			"batchStats":{"requestCount":"2","failedRequestCount":"1","successfulRequestCount":"1"},
			"output":{"inlinedResponses":{"inlinedResponses":[
			  {"response":{"candidates":[{"content":{"parts":[{"text":"11|Правка."}]}}],
			   "usageMetadata":{"promptTokenCount":1800,"candidatesTokenCount":420}},
			   "metadata":{"key":"track_a:0"}},
			  {"error":{"code":3,"message":"Request contains an invalid argument."},
			   "metadata":{"key":"track_a:1"}}]}}}}`))
	})
	job, res, err := c.Fetch(t.Context(), "batches/abc")
	if err != nil {
		t.Fatal(err)
	}
	if job.State != StateSucceeded || job.Stats.Failed != 1 {
		t.Errorf("job = %+v", job)
	}
	if len(res) != 2 {
		t.Fatalf("got %d results", len(res))
	}
	if res[0].Text != "11|Правка." || res[0].Err != nil {
		t.Errorf("first = %+v", res[0])
	}
	if res[0].TokensIn != 1800 || res[0].TokensOut != 420 {
		t.Errorf("tokens = %d/%d", res[0].TokensIn, res[0].TokensOut)
	}
	if res[1].Err == nil || !strings.Contains(res[1].Err.Error(), "invalid argument") {
		t.Errorf("second = %+v", res[1])
	}
}

func TestFetchRefusesUnfinishedJob(t *testing.T) {
	c := client(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"metadata":{"state":"BATCH_STATE_RUNNING"}}`))
	})
	if _, _, err := c.Fetch(t.Context(), "batches/abc"); err == nil ||
		!strings.Contains(err.Error(), "not ready") {
		t.Fatalf("err = %v", err)
	}
}

// A request the job never mentions is the quiet failure mode: nothing errors,
// the reply is simply absent.
func TestMissingFindsDroppedRequests(t *testing.T) {
	sent := []Request{{Key: "a:0"}, {Key: "a:1"}, {Key: "b:0"}}
	got := []Result{{Key: "a:0"}, {Key: "b:0"}}
	miss := Missing(sent, got)
	if len(miss) != 1 || miss[0] != "a:1" {
		t.Fatalf("missing = %v, want [a:1]", miss)
	}
	if len(Missing(sent, []Result{{Key: "a:0"}, {Key: "a:1"}, {Key: "b:0"}})) != 0 {
		t.Error("a complete reply set must report nothing missing")
	}
}

func TestNewValidates(t *testing.T) {
	if _, err := New(Options{Model: "m"}); err == nil {
		t.Error("empty api key must fail")
	}
	if _, err := New(Options{APIKey: "k"}); err == nil {
		t.Error("empty model must fail")
	}
	c, err := New(Options{APIKey: "k", Model: "gemini-flash-lite-latest"})
	if err != nil {
		t.Fatal(err)
	}
	if c.Model != "models/gemini-flash-lite-latest" {
		t.Errorf("model = %q, want the models/ prefix added", c.Model)
	}
	if c.Endpoint != defaultEndpoint {
		t.Errorf("endpoint = %q", c.Endpoint)
	}
}
