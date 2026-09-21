package openaicompat_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jiva-studio/shruti/pipeline/openaicompat"
)

// Zero is a temperature somebody can ask for. As a bare float64 with omitempty
// it was indistinguishable from not asking, so a caller wanting a deterministic
// answer silently got the provider's default sampling.
func TestZeroTemperatureIsAskedFor(t *testing.T) {
	var sent map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewDecoder(r.Body).Decode(&sent)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"ok"}}]}`))
	}))
	defer srv.Close()

	c, err := openaicompat.New(openaicompat.Options{Endpoint: srv.URL, APIKey: "k"})
	if err != nil {
		t.Fatal(err)
	}
	zero := 0.0
	if _, err := c.Run(t.Context(), openaicompat.Call{
		Model: "m", User: "u", MaxTokens: 16, Temperature: &zero,
	}); err != nil {
		t.Fatal(err)
	}
	if got, ok := sent["temperature"]; !ok || got != float64(0) {
		t.Errorf("temperature sent as %v (present=%v), want 0", got, ok)
	}

	sent = nil
	if _, err := c.Run(t.Context(), openaicompat.Call{Model: "m", User: "u", MaxTokens: 16}); err != nil {
		t.Fatal(err)
	}
	if _, ok := sent["temperature"]; ok {
		t.Error("temperature was sent when none was asked for")
	}
}
