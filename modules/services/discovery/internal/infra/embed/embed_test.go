package embed_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jiva-studio/shruti/discovery/internal/infra/embed"
)

// Vectors are the one thing here that cannot be checked by looking at them: a
// batch returned in the wrong order, or one vector short, produces a search
// that works and answers wrongly. These are the checks that catch that.

type reply struct {
	Data []item `json:"data"`
}

type item struct {
	Index     int       `json:"index"`
	Embedding []float32 `json:"embedding"`
}

// server answers embedding requests with handler, and records what it was asked.
func server(t *testing.T, handler func(w http.ResponseWriter, r *http.Request, in map[string]any)) (*embed.Client, *int) {
	t.Helper()
	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var in map[string]any
		_ = json.NewDecoder(r.Body).Decode(&in)
		w.Header().Set("Content-Type", "application/json")
		handler(w, r, in)
	}))
	t.Cleanup(srv.Close)

	c, err := embed.New(embed.Options{
		BaseURL: srv.URL, APIKey: "k", Model: "text-embedding-3-small", Dim: 3,
	})
	if err != nil {
		t.Fatal(err)
	}
	return c, &calls
}

// vectors answers one vector per input, each carrying its own position so a
// reordering is visible.
func vectors(w http.ResponseWriter, _ *http.Request, in map[string]any) {
	inputs, _ := in["input"].([]any)
	out := reply{}
	for i := range inputs {
		out.Data = append(out.Data, item{Index: i, Embedding: []float32{float32(i), 0, 0}})
	}
	_ = json.NewEncoder(w).Encode(out)
}

func TestUnconfiguredIsAnErrorNotASilentNoOp(t *testing.T) {
	for _, opts := range []embed.Options{
		{APIKey: "k", Model: "m"},
		{BaseURL: "https://x", Model: "m"},
		{BaseURL: "https://x", APIKey: "k"},
	} {
		if _, err := embed.New(opts); err == nil {
			t.Errorf("%+v was accepted; a half-configured embedder would fail on the first page", opts)
		}
	}
}

func TestOneVectorPerInputInOrder(t *testing.T) {
	c, calls := server(t, vectors)

	got, err := c.Embed(context.Background(), []string{"a", "b", "c"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("%d vectors for 3 texts", len(got))
	}
	for i, v := range got {
		if v[0] != float32(i) {
			t.Errorf("vector %d belongs to input %v; the order was not kept", i, v[0])
		}
	}
	if *calls != 1 {
		t.Errorf("%d calls for one small batch", *calls)
	}
}

// The provider is free to answer out of order — the index is what says which
// text a vector belongs to, and trusting position instead would attach the
// wrong words to the wrong recording.
func TestAnswersAreMatchedByIndexNotByPosition(t *testing.T) {
	c, _ := server(t, func(w http.ResponseWriter, _ *http.Request, in map[string]any) {
		inputs, _ := in["input"].([]any)
		out := reply{}
		for i := len(inputs) - 1; i >= 0; i-- {
			out.Data = append(out.Data, item{Index: i, Embedding: []float32{float32(i), 0, 0}})
		}
		_ = json.NewEncoder(w).Encode(out)
	})

	got, err := c.Embed(context.Background(), []string{"a", "b", "c"})
	if err != nil {
		t.Fatal(err)
	}
	for i, v := range got {
		if v[0] != float32(i) {
			t.Errorf("vector %d = %v; a reversed reply was taken at face value", i, v[0])
		}
	}
}

// A batch that comes back short must fail. Quietly returning fewer vectors than
// texts shifts every vector after the gap onto the wrong recording.
func TestAShortAnswerIsAnError(t *testing.T) {
	c, _ := server(t, func(w http.ResponseWriter, _ *http.Request, in map[string]any) {
		inputs, _ := in["input"].([]any)
		out := reply{}
		for i := range len(inputs) - 1 {
			out.Data = append(out.Data, item{Index: i, Embedding: []float32{float32(i), 0, 0}})
		}
		_ = json.NewEncoder(w).Encode(out)
	})

	if got, err := c.Embed(context.Background(), []string{"a", "b", "c"}); err == nil {
		t.Errorf("got %d vectors for 3 texts and no error", len(got))
	}
}

// The provider's own error is passed on rather than turned into empty vectors.
func TestProviderErrorSurfaces(t *testing.T) {
	c, _ := server(t, func(w http.ResponseWriter, _ *http.Request, _ map[string]any) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"message":"model not found"}}`))
	})

	_, err := c.Embed(context.Background(), []string{"a"})
	if err == nil {
		t.Fatal("a refused request came back as success")
	}
	if !strings.Contains(err.Error(), "model not found") {
		t.Errorf("err = %v; the provider said why and it was dropped", err)
	}
}

// The dimension asked for has to reach the provider: a vector of the wrong
// length fails every insert, and finding that out at write time is late.
func TestTheDimensionIsAskedFor(t *testing.T) {
	var asked float64
	c, _ := server(t, func(w http.ResponseWriter, r *http.Request, in map[string]any) {
		asked, _ = in["dimensions"].(float64)
		if got := r.Header.Get("Authorization"); got == "" {
			t.Error("no credentials on the request")
		}
		vectors(w, r, in)
	})

	if _, err := c.Embed(context.Background(), []string{"a"}); err != nil {
		t.Fatal(err)
	}
	if int(asked) != c.Dim() {
		t.Errorf("asked for %v, configured %d", asked, c.Dim())
	}
}

// A corpus is embedded in the thousands. The batch size is what keeps one
// request from being refused for its size, and every text still has to come
// back exactly once.
func TestLargeInputIsSplitAndRejoined(t *testing.T) {
	c, calls := server(t, vectors)

	texts := make([]string, 250)
	for i := range texts {
		texts[i] = "text"
	}
	got, err := c.Embed(context.Background(), texts)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(texts) {
		t.Errorf("%d vectors for %d texts", len(got), len(texts))
	}
	if *calls < 2 {
		t.Errorf("%d call(s); 250 texts should not go in one request", *calls)
	}
}

func TestNothingToEmbedCostsNoCall(t *testing.T) {
	c, calls := server(t, vectors)
	got, err := c.Embed(context.Background(), nil)
	if err != nil || len(got) != 0 {
		t.Fatalf("= %v, %v", got, err)
	}
	if *calls != 0 {
		t.Errorf("%d calls for nothing", *calls)
	}
}
