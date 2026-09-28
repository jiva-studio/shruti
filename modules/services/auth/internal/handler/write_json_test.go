package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

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
