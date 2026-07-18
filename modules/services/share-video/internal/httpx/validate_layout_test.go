package httpx

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jiva-studio/shruti-share-video/internal/types"
)

// parseBody runs the JSON body through parseRenderRequest and returns the
// parsed request plus the validation error string ("" on success).
func parseBody(t *testing.T, body string) (types.RenderRequest, string) {
	t.Helper()
	r := httptest.NewRequest("POST", "/reels", strings.NewReader(body))
	req, err := parseRenderRequest(r)
	if err != nil {
		return types.RenderRequest{}, err.Error()
	}
	return req, ""
}

const baseFields = `"source_key":"public/tracks/x/a.mp3","start_ms":0,"end_ms":5000,"lang":"en","theme":"sunrise"`

func TestParse_LegacyRequiresText(t *testing.T) {
	// No layout → legacy path → transcript on → text required.
	_, errMsg := parseBody(t, "{"+baseFields+"}")
	if !strings.Contains(errMsg, "text is required") {
		t.Fatalf("want text-required error, got %q", errMsg)
	}
}

func TestParse_TranscriptOffMakesTextOptional(t *testing.T) {
	body := `{` + baseFields + `,"layout":{"sections":{` +
		`"transcript":{"enabled":false},` +
		`"header":{"enabled":true,"text":"Why do we suffer?","sub":"BG 2.14"}}}}`
	req, errMsg := parseBody(t, body)
	if errMsg != "" {
		t.Fatalf("unexpected error: %s", errMsg)
	}
	rl := req.ResolveLayout()
	if rl.Transcript {
		t.Fatalf("transcript should be off")
	}
	if rl.Header == nil || rl.Header.Text != "Why do we suffer?" {
		t.Fatalf("header not resolved: %+v", rl.Header)
	}
}

func TestParse_EmptyLayoutRejected(t *testing.T) {
	// Transcript explicitly off and no visible section → rejected.
	body := `{` + baseFields + `,"text":"hi","layout":{"sections":{"transcript":{"enabled":false}}}}`
	_, errMsg := parseBody(t, body)
	if !strings.Contains(errMsg, "no visible content") {
		t.Fatalf("want no-visible-content error, got %q", errMsg)
	}
}

func TestParse_HeaderEnabledNeedsText(t *testing.T) {
	body := `{` + baseFields + `,"text":"hi","layout":{"sections":{"header":{"enabled":true}}}}`
	_, errMsg := parseBody(t, body)
	if !strings.Contains(errMsg, "header.text is required") {
		t.Fatalf("want header.text-required error, got %q", errMsg)
	}
}

func TestParse_CenterEnabledNeedsShloka(t *testing.T) {
	body := `{` + baseFields + `,"text":"hi","layout":{"sections":{"center":{"enabled":true,"shloka":{}}}}}`
	_, errMsg := parseBody(t, body)
	if !strings.Contains(errMsg, "iast or translation") {
		t.Fatalf("want shloka-required error, got %q", errMsg)
	}
}

func TestParse_AudioAndLayoutRoundTrip(t *testing.T) {
	body := `{` + baseFields + `,"text":"hi","audio":{"normalize":true,"trim_silence":true},` +
		`"layout":{"outro":{"enabled":false},"sections":{"center":{"enabled":true,` +
		`"shloka":{"iast":"mātrā-sparśās","translation":"the senses"}}}}}`
	req, errMsg := parseBody(t, body)
	if errMsg != "" {
		t.Fatalf("unexpected error: %s", errMsg)
	}
	if req.Audio == nil || !req.Audio.Normalize || !req.Audio.TrimSilence {
		t.Fatalf("audio not parsed: %+v", req.Audio)
	}
	rl := req.ResolveLayout()
	if rl.OutroEnabled {
		t.Fatalf("outro should be disabled")
	}
	if rl.Center == nil || rl.Center.Shloka == nil || rl.Center.Shloka.IAST != "mātrā-sparśās" {
		t.Fatalf("center shloka not resolved: %+v", rl.Center)
	}
}

func TestParse_UnknownLayoutFieldRejected(t *testing.T) {
	// DisallowUnknownFields must reach nested objects.
	body := `{` + baseFields + `,"text":"hi","layout":{"sections":{"header":{"enabled":true,"text":"x","bogus":1}}}}`
	_, errMsg := parseBody(t, body)
	if !strings.Contains(errMsg, "bogus") {
		t.Fatalf("want unknown-field error mentioning bogus, got %q", errMsg)
	}
}
