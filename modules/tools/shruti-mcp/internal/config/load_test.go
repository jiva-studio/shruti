package config

import (
	"os"
	"path/filepath"
	"testing"
)

func writeConfig(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "shruti-mcp.yaml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoadAppliesEachSectionsDefaults(t *testing.T) {
	c, err := Load(writeConfig(t, `
in: /lake/in
out: /lake/out
s3:
  aws: {bucket: b}
review:
  providers:
    lite: {model: m}
resolver:
  providers:
    haiku: {model: h}
`))
	if err != nil {
		t.Fatal(err)
	}
	checks := map[string]bool{
		"db":                  c.DB == filepath.Join("/lake/out", "artifacts", "lake", "index.db"),
		"runs_db":             c.RunsDB == filepath.Join("/lake/out", "artifacts", "lake", "runs.db"),
		"default_language":    c.DefaultLanguage == "ru",
		"bunny endpoint":      c.S3.Bunny.Endpoint == "",
		"ffmpeg":              c.FFmpeg.Bin == "ffmpeg",
		"transcribe default":  c.Transcribe.Default == "transcriber-service",
		"review chunk":        c.Review.ChunkSize == 50,
		"review provider max": c.Review.Providers["lite"].MaxTokens == 4096,
		"resolver provider":   c.Resolver.Providers["haiku"].MaxTokens == 1024,
		"resolver top n":      c.Resolver.CandidatesTopN == 30,
		"metadata max tokens": c.Metadata.MaxTokens == 1024,
		"topics k":            c.Topics.K == 150,
		"image style":         c.Images.Style == defaultImageStyle,
	}
	for name, ok := range checks {
		if !ok {
			t.Errorf("default for %s not applied: %+v", name, c)
		}
	}
}

func TestLoadRequiresInAndOut(t *testing.T) {
	if _, err := Load(writeConfig(t, "out: /x\n")); err == nil {
		t.Fatal("a config without `in` loaded")
	}
}

func TestReviewAttemptAcceptsBothShapes(t *testing.T) {
	c, err := Load(writeConfig(t, `
in: /i
out: /o
review:
  default:
    ru:
      - [lite, flash]
      - models: [pro]
        threshold: 0.5
`))
	if err != nil {
		t.Fatal(err)
	}
	got := c.Review.DefaultReviewAttempts("ru")
	if len(got) != 2 || len(got[0].Models) != 2 || got[1].Models[0] != "pro" || *got[1].Threshold != 0.5 {
		t.Fatalf("attempts %+v", got)
	}
	if c.Review.DefaultReviewAttempts("en") != nil {
		t.Fatal("a language without a chain or a \"*\" fallback got one")
	}
}
