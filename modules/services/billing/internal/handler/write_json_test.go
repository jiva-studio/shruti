package handler

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestWriteJSONLogsAnEncodeFailure: a body that cannot be encoded is logged
// with the status already sent, not dropped.
func TestWriteJSONLogsAnEncodeFailure(t *testing.T) {
	var logs bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	writeJSON(httptest.NewRecorder(), http.StatusOK, make(chan int))

	out := logs.String()
	if !strings.Contains(out, "http_response_encode_failed") || !strings.Contains(out, "status=200") {
		t.Fatalf("encode failure not logged; logs:\n%s", out)
	}
}
