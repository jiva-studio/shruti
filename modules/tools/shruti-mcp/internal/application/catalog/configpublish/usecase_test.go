package configpublish

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	s3port "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/s3"
)

type fakeUploader struct {
	name    string
	objects map[string][]byte
}

func newFake(name string) *fakeUploader {
	return &fakeUploader{name: name, objects: map[string][]byte{}}
}

func (f *fakeUploader) Name() string   { return f.name }
func (f *fakeUploader) Bucket() string { return f.name + "-bucket" }
func (f *fakeUploader) Put(_ context.Context, key, _ string, body io.Reader, _ int64) error {
	data, err := io.ReadAll(body)
	if err != nil {
		return err
	}
	f.objects[key] = data
	return nil
}
func (f *fakeUploader) Get(_ context.Context, key string) ([]byte, bool, error) {
	data, ok := f.objects[key]
	return data, ok, nil
}
func (f *fakeUploader) GetJSON(_ context.Context, key string, out any) (bool, error) {
	data, ok := f.objects[key]
	if !ok {
		return false, nil
	}
	return true, json.Unmarshal(data, out)
}
func (f *fakeUploader) Head(_ context.Context, _ string) (int64, string, bool, error) {
	return 0, "", false, nil
}
func (f *fakeUploader) cfg(t *testing.T) map[string]json.RawMessage {
	t.Helper()
	var m map[string]json.RawMessage
	if err := json.Unmarshal(f.objects["public/config.json"], &m); err != nil {
		t.Fatalf("config.json not valid: %v", err)
	}
	return m
}

func writeLocal(t *testing.T, outDir, raw string) {
	t.Helper()
	dir := filepath.Join(outDir, "artifacts", "catalog")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte(raw), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestPublishWritesSectionsToAllTargetsPreservingDatabases(t *testing.T) {
	out := t.TempDir()
	writeLocal(t, out, `{"regions":[{"id":"global"}],"proactive":{"master_enabled":true}}`)
	aws, ya := newFake("aws"), newFake("yandex")
	// Each target already has a databases pointer that must survive.
	aws.objects["public/config.json"] = []byte(`{"databases":[{"version":7}]}`)
	ya.objects["public/config.json"] = []byte(`{"databases":[{"version":7}]}`)

	uc := UseCase{OutDir: out, Targets: []s3port.Uploader{aws, ya}, OpMutex: &sync.Mutex{}}
	res, err := uc.Run(t.Context(), Options{})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if len(res.Targets) != 2 {
		t.Fatalf("expected 2 targets, got %+v", res.Targets)
	}
	for _, f := range []*fakeUploader{aws, ya} {
		m := f.cfg(t)
		for _, k := range []string{"regions", "proactive", "databases"} {
			if _, ok := m[k]; !ok {
				t.Errorf("%s: key %q missing after publish", f.name, k)
			}
		}
		if !strings.Contains(string(m["databases"]), "7") {
			t.Errorf("%s: databases pointer clobbered: %s", f.name, m["databases"])
		}
	}
}

func TestPublishMissingLocalConfigErrors(t *testing.T) {
	uc := UseCase{OutDir: t.TempDir(), Targets: []s3port.Uploader{newFake("aws")}, OpMutex: &sync.Mutex{}}
	if _, err := uc.Run(t.Context(), Options{}); err == nil {
		t.Fatal("expected error when local config.json missing")
	}
}

func TestPublishLeavesAbsentSectionUntouched(t *testing.T) {
	out := t.TempDir()
	// Local config has proactive only — must not clear an existing S3 regions.
	writeLocal(t, out, `{"proactive":{"master_enabled":false}}`)
	aws := newFake("aws")
	aws.objects["public/config.json"] = []byte(`{"regions":[{"id":"keepme"}],"databases":[]}`)

	uc := UseCase{OutDir: out, Targets: []s3port.Uploader{aws}, OpMutex: &sync.Mutex{}}
	if _, err := uc.Run(t.Context(), Options{}); err != nil {
		t.Fatalf("run: %v", err)
	}
	m := aws.cfg(t)
	if !strings.Contains(string(m["regions"]), "keepme") {
		t.Fatalf("absent local section cleared S3 regions: %s", m["regions"])
	}
	if !strings.Contains(string(m["proactive"]), "false") {
		t.Fatalf("proactive not published: %s", m["proactive"])
	}
}

func TestPublishDryRunUploadsNothing(t *testing.T) {
	out := t.TempDir()
	writeLocal(t, out, `{"regions":[{"id":"global"}]}`)
	aws := newFake("aws")
	uc := UseCase{OutDir: out, Targets: []s3port.Uploader{aws}, OpMutex: &sync.Mutex{}}
	res, err := uc.Run(t.Context(), Options{DryRun: true})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if !res.DryRun {
		t.Fatal("expected DryRun=true")
	}
	if _, uploaded := aws.objects["public/config.json"]; uploaded {
		t.Fatal("dry run must not upload")
	}
}
