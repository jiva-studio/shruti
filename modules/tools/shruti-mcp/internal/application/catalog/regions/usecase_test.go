package regions

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func newUC(t *testing.T) UseCase {
	t.Helper()
	return UseCase{OutDir: t.TempDir(), Mu: &sync.Mutex{}}
}

func configPath(uc UseCase) string {
	return filepath.Join(uc.OutDir, "artifacts", "catalog", "config.json")
}

func seedConfig(t *testing.T, uc UseCase, raw string) {
	t.Helper()
	path := configPath(uc)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte(raw), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
}

func readConfig(t *testing.T, uc UseCase) map[string]json.RawMessage {
	t.Helper()
	data, err := os.ReadFile(configPath(uc))
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("config not valid JSON: %v", err)
	}
	return m
}

func validRegion(id string) Region {
	return Region{
		ID:            id,
		Name:          id,
		URLTemplate:   "https://bucket.example.com/{path}",
		ShareAudioURL: "https://host.example.com/share/audio/excerpts",
		ShareVideoURL: "https://host.example.com/share/video/reels",
		AuthBaseURL:   "https://host.example.com/auth",
		ChatBaseURL:   "https://host.example.com",
	}
}

func TestUpsertCreatesAndPreservesOtherKeys(t *testing.T) {
	uc := newUC(t)
	seedConfig(t, uc, `{"proactive":{"master_enabled":true},"databases":[{"version":1}]}`)

	if _, err := uc.Upsert(validRegion("global")); err != nil {
		t.Fatalf("upsert: %v", err)
	}

	m := readConfig(t, uc)
	for _, k := range []string{"proactive", "databases", "regions"} {
		if _, ok := m[k]; !ok {
			t.Errorf("key %q missing after upsert — other keys must round-trip", k)
		}
	}
	list, err := uc.List()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 1 || list[0].ID != "global" {
		t.Fatalf("expected [global], got %+v", list)
	}
}

func TestUpsertReplacesInPlacePreservingOrder(t *testing.T) {
	uc := newUC(t)
	for _, id := range []string{"a", "b", "c"} {
		if _, err := uc.Upsert(validRegion(id)); err != nil {
			t.Fatalf("seed upsert %s: %v", id, err)
		}
	}
	updated := validRegion("b")
	updated.Name = "Bravo"
	if _, err := uc.Upsert(updated); err != nil {
		t.Fatalf("replace upsert: %v", err)
	}
	list, _ := uc.List()
	if len(list) != 3 || list[0].ID != "a" || list[1].ID != "b" || list[2].ID != "c" {
		t.Fatalf("order changed: %+v", list)
	}
	if list[1].Name != "Bravo" {
		t.Fatalf("expected replaced name Bravo, got %q", list[1].Name)
	}
}

func TestUpsertValidation(t *testing.T) {
	uc := newUC(t)
	cases := map[string]func(Region) Region{
		"id":            func(r Region) Region { r.ID = "Bad Id"; return r },
		"name":          func(r Region) Region { r.Name = "  "; return r },
		"urlTemplate":   func(r Region) Region { r.URLTemplate = "https://x/no-placeholder"; return r },
		"authBaseUrl":   func(r Region) Region { r.AuthBaseURL = "http://insecure"; return r },
		"shareAudioUrl": func(r Region) Region { r.ShareAudioURL = "not-a-url"; return r },
	}
	for field, mutate := range cases {
		_, err := uc.Upsert(mutate(validRegion("global")))
		var ve *ValidationError
		if !errors.As(err, &ve) {
			t.Errorf("%s: expected ValidationError, got %v", field, err)
			continue
		}
		if ve.Field != field {
			t.Errorf("expected field %q, got %q", field, ve.Field)
		}
	}
}

func TestGetNotFound(t *testing.T) {
	uc := newUC(t)
	_, _ = uc.Upsert(validRegion("global"))
	_, err := uc.Get("missing")
	var nfe *NotFoundError
	if !errors.As(err, &nfe) {
		t.Fatalf("expected NotFoundError, got %v", err)
	}
}

func TestRemove(t *testing.T) {
	uc := newUC(t)
	_, _ = uc.Upsert(validRegion("a"))
	_, _ = uc.Upsert(validRegion("b"))

	removed, err := uc.Remove("a")
	if err != nil {
		t.Fatalf("remove: %v", err)
	}
	if removed != "a" {
		t.Fatalf("expected removed=a, got %q", removed)
	}
	list, _ := uc.List()
	if len(list) != 1 || list[0].ID != "b" {
		t.Fatalf("expected [b], got %+v", list)
	}
}

func TestRemoveNotFound(t *testing.T) {
	uc := newUC(t)
	_, _ = uc.Upsert(validRegion("a"))
	_, _ = uc.Upsert(validRegion("b"))
	_, err := uc.Remove("missing")
	var nfe *NotFoundError
	if !errors.As(err, &nfe) {
		t.Fatalf("expected NotFoundError, got %v", err)
	}
}

func TestRemoveLastRefused(t *testing.T) {
	uc := newUC(t)
	_, _ = uc.Upsert(validRegion("only"))
	_, err := uc.Remove("only")
	var ce *ConflictError
	if !errors.As(err, &ce) {
		t.Fatalf("expected ConflictError removing last region, got %v", err)
	}
}

func TestListEmptyOnFreshDir(t *testing.T) {
	uc := newUC(t)
	list, err := uc.List()
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("expected empty, got %+v", list)
	}
}
