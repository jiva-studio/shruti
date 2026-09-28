package httpx

import (
	"encoding/json"
	"strings"
	"testing"
)

func sourceKeyBody(t *testing.T, key string) string {
	t.Helper()
	k, err := json.Marshal(key)
	if err != nil {
		t.Fatal(err)
	}
	return `{"source_key":` + string(k) + `,"start_ms":0,"end_ms":5000,"lang":"en","theme":"sunrise","text":"hi"}`
}

func TestParse_SourceKeyOffItsShapeIsRejected(t *testing.T) {
	for _, key := range []string{
		"public/tracks/../../private/backups/db.mp3",
		"public/tracks/t/../../private/x.mp3",
		"public/tracks/./t/a.mp3",
		"public/tracks//a.mp3",
		"public/tracks/a#b.mp3",
		"public/tracks/a?b.mp3",
		"public/tracks/%2e%2e/a.mp3",
		`public/tracks/a\..\b.mp3`,
		"public/tracks/t/.mp3",
		"public/tracks/t/a.mp3\n",
		"public/tracks/t/a b.mp3",
		"private/tracks/t/a.mp3",
	} {
		t.Run(key, func(t *testing.T) {
			_, errMsg := parseBody(t, sourceKeyBody(t, key))
			if !strings.Contains(errMsg, "source_key") {
				t.Fatalf("source_key %q accepted (err %q)", key, errMsg)
			}
		})
	}
}

func TestParse_SourceKeyOfTheExpectedShapeIsAccepted(t *testing.T) {
	for _, key := range []string{
		"public/tracks/track_aBC-123/audio/original.mp3",
		"public/shares/audio/0123abcd.mp3",
		"public/tracks/t/audio/clean.v2.mp3",
	} {
		t.Run(key, func(t *testing.T) {
			if _, errMsg := parseBody(t, sourceKeyBody(t, key)); errMsg != "" {
				t.Fatalf("source_key %q rejected: %s", key, errMsg)
			}
		})
	}
}
