package runingest

import (
	"encoding/json"
	"strings"
	"testing"
)

// The whole point of failData: nothing internal reaches the user's device. The
// payload is projected into library_items and synced down, so a raw
// "transcribe: deepgram: 503" would leak both our pipeline stages and our
// vendors into a row on the user's phone. The `error` field carries only the
// STABLE code (the key the whole downstream chain maps), never the raw text.
func TestFailDataNeverShipsTheRawError(t *testing.T) {
	raw := "transcribe: deepgram: 503 Service Unavailable"
	var got map[string]any
	if err := json.Unmarshal(failData(raw, "A talk"), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if got["error"] != codeInternal {
		t.Errorf("error = %v, want the stable code %q", got["error"], codeInternal)
	}
	if got["status"] != "failed" || got["title_raw"] != "A talk" {
		t.Errorf("status/title must survive, got %v", got)
	}

	// Belt and braces: no fragment of the internal text may appear anywhere in
	// the serialized payload.
	blob := string(failData(raw, "A talk"))
	for _, leak := range []string{"deepgram", "503", "transcribe"} {
		if strings.Contains(strings.ToLower(blob), leak) {
			t.Errorf("payload leaks %q: %s", leak, blob)
		}
	}
}

func TestFailCode(t *testing.T) {
	cases := []struct {
		name, msg, want string
	}{
		{"pro gate", "pro tier not verified", codeUnauthorized},
		{"bad url", "fetch: yt-dlp (permanent): unsupported url: foo", codeUnsupported},
		{"oversize", "fetch: source exceeds max duration", codeTooLarge},
		{"silent audio", "transcription produced no blocks", codeNoSpeech},
		{"private source", "fetch: yt-dlp (permanent): private video", codeUnavailable},
		{"deleted source", "fetch: yt-dlp (permanent): this video has been removed", codeUnavailable},
		{"our fault", "put audio: connection reset by peer", codeInternal},
		// A 5xx from a vendor is OUR problem, not a dead source. "Service
		// Unavailable" must not be mistaken for "video unavailable".
		{"vendor 5xx is not a dead source", "transcribe: deepgram: 503 Service Unavailable", codeInternal},
		{"empty", "", codeInternal},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := failCode(tc.msg); got != tc.want {
				t.Fatalf("failCode(%q) = %q, want %q", tc.msg, got, tc.want)
			}
		})
	}
}

// A code we cannot classify must degrade to `internal`, never to the message —
// this is the property that keeps the leak closed as new errors appear.
func TestFailCodeUnknownDegradesToInternal(t *testing.T) {
	if got := failCode("some brand new failure nobody mapped yet"); got != codeInternal {
		t.Fatalf("unknown error = %q, want %q", got, codeInternal)
	}
}

// statusData stays untouched by the above — the pre-ready cards carry no error.
func TestStatusDataShape(t *testing.T) {
	var got map[string]any
	if err := json.Unmarshal(statusData("queued", "A talk"), &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got["status"] != "queued" || got["title_raw"] != "A talk" {
		t.Fatalf("unexpected payload: %v", got)
	}
	if len(got) != 2 {
		t.Errorf("statusData grew unexpectedly: %v", got)
	}
}
