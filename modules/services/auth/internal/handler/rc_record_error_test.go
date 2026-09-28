package handler

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jiva-studio/shruti/auth/internal/rcclient"
)

type failingEvents struct{}

func (failingEvents) RecordError(context.Context, string, string) error {
	return errors.New("db down")
}

// captureLogs routes the default slog logger into a buffer for the test.
func captureLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return &buf
}

// TestRecordErrorFailureIsLogged: when storing the refetch failure on the
// webhook row itself fails, that second failure is logged with the event
// id, not dropped.
func TestRecordErrorFailureIsLogged(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
	}{
		{"permanent", fmt.Errorf("%w: status=401", rcclient.ErrPermanent)},
		{"transient", errors.New("rcclient: 502 Bad Gateway")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			logs := captureLogs(t)
			h := &RCWebhookHandler{
				SecretPrimary: "s",
				Applier:       &stubApplier{},
				Events:        failingEvents{},
				Fetcher:       &stubFetcher{err: tc.err},
			}
			h.ServeHTTP(httptest.NewRecorder(), mkRequest(t, "s", map[string]any{
				"event": map[string]any{"id": "evt_rec_" + tc.name, "app_user_id": "u", "environment": "PRODUCTION"},
			}))
			out := logs.String()
			if !strings.Contains(out, "rc_webhook_record_error_failed") || !strings.Contains(out, "evt_rec_"+tc.name) {
				t.Fatalf("RecordError failure not logged; logs:\n%s", out)
			}
		})
	}
}
