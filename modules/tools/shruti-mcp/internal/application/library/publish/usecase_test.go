package librarypublish

import (
	"context"
	"encoding/json"
	"io"
	"strings"
	"testing"
	"time"

	s3port "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/s3"
)

// bucket is one fake target holding config.json and everything put to it.
type bucket struct {
	config string
	puts   map[string][]byte
}

func (b *bucket) Name() string   { return "fake" }
func (b *bucket) Bucket() string { return "fake-bucket" }
func (b *bucket) Put(_ context.Context, key, _ string, body io.Reader, _ int64) error {
	data, err := io.ReadAll(body)
	if err != nil {
		return err
	}
	b.puts[key] = data
	if key == "public/config.json" {
		b.config = string(data)
	}
	return nil
}
func (b *bucket) GetJSON(_ context.Context, key string, out any) (bool, error) {
	if key != "public/config.json" || b.config == "" {
		return false, nil
	}
	return true, json.Unmarshal([]byte(b.config), out)
}
func (b *bucket) Get(context.Context, string) ([]byte, bool, error) { return nil, false, nil }
func (b *bucket) Head(context.Context, string) (int64, string, bool, error) {
	return 0, "", false, nil
}

type library []byte

func (l library) Snapshot(context.Context) ([]byte, error) { return l, nil }

type fixedClock struct{}

func (fixedClock) Now() time.Time { return time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC) }

func TestRunAddsTheVersionAndKeepsEverythingElse(t *testing.T) {
	b := &bucket{
		config: `{"databases":[{"version":1,"scheme":20260621}],"library":{"versions":[{"version":20260101000000}]}}`,
		puts:   map[string][]byte{},
	}
	uc := UseCase{Library: library("db-bytes"), Targets: []s3port.Uploader{b}, Clock: fixedClock{}}
	res, err := uc.Run(t.Context(), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if string(b.puts["public/library/library.20260901120000.db"]) != "db-bytes" || res.Version != 20260901120000 {
		t.Fatalf("uploaded %v as version %d", keys(b.puts), res.Version)
	}
	var cfg struct {
		Databases []map[string]int64 `json:"databases"`
		Library   librarySection     `json:"library"`
	}
	if err := json.Unmarshal([]byte(b.config), &cfg); err != nil {
		t.Fatal(err)
	}
	if len(cfg.Databases) != 1 {
		t.Fatalf("the catalog's databases list changed: %s", b.config)
	}
	if len(cfg.Library.Versions) != 2 || cfg.Library.Versions[0].Version != 20260901120000 {
		t.Fatalf("library versions %+v", cfg.Library.Versions)
	}
}

func TestRunRefusesAnUnreadableLibrarySection(t *testing.T) {
	b := &bucket{config: `{"library":{"versions":"oops"}}`, puts: map[string][]byte{}}
	uc := UseCase{Library: library("db"), Targets: []s3port.Uploader{b}, Clock: fixedClock{}}
	_, err := uc.Run(t.Context(), Options{})
	if err == nil || !strings.Contains(err.Error(), "unreadable") {
		t.Fatalf("Run = %v, want a refusal", err)
	}
	if len(b.puts) != 0 {
		t.Fatalf("uploaded %v over an unreadable section", keys(b.puts))
	}
}

func keys(m map[string][]byte) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
