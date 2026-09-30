package handler

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// captureLogs routes the default slog logger into a buffer for the test.
func captureLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return &buf
}

// TestWriteJSONLogsAnEncodeFailure: a body that cannot be encoded is logged
// with the status already sent, not dropped.
func TestWriteJSONLogsAnEncodeFailure(t *testing.T) {
	logs := captureLogs(t)

	writeJSON(httptest.NewRecorder(), http.StatusOK, make(chan int))

	out := logs.String()
	if !strings.Contains(out, "http_response_encode_failed") || !strings.Contains(out, "status=200") {
		t.Fatalf("encode failure not logged; logs:\n%s", out)
	}
}
