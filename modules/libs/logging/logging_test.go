package logging

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"regexp"
	"testing"
)

func decodeLine(t *testing.T, buf *bytes.Buffer) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(buf.Bytes(), &m); err != nil {
		t.Fatalf("decode %q: %v", buf.String(), err)
	}
	return m
}

func TestSetupWritesThePipelineFieldNames(t *testing.T) {
	prev := slog.Default()
	t.Cleanup(func() { slog.SetDefault(prev) })

	var buf bytes.Buffer
	SetupTo(&buf, "svc", "prod", "1.2.3")
	ctx := WithRunID(WithUserID(WithRequestID(t.Context(), "req-1"), "user-1"), 7)
	slog.InfoContext(ctx, "hello", "k", "v")

	m := decodeLine(t, &buf)
	want := map[string]any{
		"message":    "hello",
		"level":      "INFO",
		"service":    "svc",
		"env":        "prod",
		"version":    "1.2.3",
		"request_id": "req-1",
		"user_id":    "user-1",
		"run_id":     float64(7),
		"k":          "v",
	}
	for k, v := range want {
		if m[k] != v {
			t.Errorf("%s = %v, want %v", k, m[k], v)
		}
	}
	if _, ok := m["timestamp"]; !ok {
		t.Error("timestamp missing")
	}
	for _, k := range []string{"msg", "time"} {
		if _, ok := m[k]; ok {
			t.Errorf("slog's own key %q leaked into the line", k)
		}
	}
}

func TestSetupOmitsAbsentContextFields(t *testing.T) {
	prev := slog.Default()
	t.Cleanup(func() { slog.SetDefault(prev) })

	var buf bytes.Buffer
	SetupTo(&buf, "svc", "prod", "1")
	slog.InfoContext(t.Context(), "bare")

	m := decodeLine(t, &buf)
	for _, k := range []string{"request_id", "user_id", "run_id"} {
		if _, ok := m[k]; ok {
			t.Errorf("%s present on a context that never set it", k)
		}
	}
}

func TestRecoveredLogsThePanic(t *testing.T) {
	prev := slog.Default()
	t.Cleanup(func() { slog.SetDefault(prev) })

	var buf bytes.Buffer
	SetupTo(&buf, "svc", "prod", "1")
	func() {
		defer Recovered(t.Context(), "worker")
		panic("boom")
	}()

	m := decodeLine(t, &buf)
	if m["message"] != "panic_recovered" || m["in"] != "worker" || m["panic"] != "boom" || m["level"] != "ERROR" {
		t.Fatalf("got %v", m)
	}
	if s, _ := m["stack"].(string); s == "" {
		t.Error("stack missing")
	}
}

func TestNewPinoKeepsPinoShape(t *testing.T) {
	var buf bytes.Buffer
	l := NewPinoTo(&buf, "warn", "share", "prod", "9")
	l.Info("dropped below warn")
	if buf.Len() != 0 {
		t.Fatalf("info logged at level warn: %s", buf.String())
	}
	l.Warn("kept")

	m := decodeLine(t, &buf)
	if m["level"] != "warn" || m["message"] != "kept" || m["service"] != "share" || m["env"] != "prod" || m["version"] != "9" {
		t.Fatalf("got %v", m)
	}
	if _, ok := m["pid"].(float64); !ok {
		t.Errorf("pid = %v, want a number", m["pid"])
	}
	ts, _ := m["timestamp"].(string)
	if !regexp.MustCompile(`^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$`).MatchString(ts) {
		t.Errorf("timestamp %q is not millisecond UTC", ts)
	}
}

func TestFromFallsBackToDefault(t *testing.T) {
	if From(t.Context()) != slog.Default() {
		t.Error("From without Into is not slog.Default")
	}
	l := slog.New(slog.DiscardHandler)
	if From(Into(t.Context(), l)) != l {
		t.Error("From did not return the logger stored by Into")
	}
}
