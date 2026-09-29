package pipeline

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"testing"
)

// clearListCache empties the process-wide theme listing cache, so a test
// sees its own store's listing and not one cached by an earlier run.
func clearListCache() {
	listCacheMu.Lock()
	defer listCacheMu.Unlock()
	listCache = map[string]listEntry{}
}

// fakeStore is safe for the concurrent downloads downloadAll makes.
type fakeStore struct {
	mu         sync.Mutex
	listing    map[string][]string
	objects    map[string]string
	listed     []string
	downloaded []string
	put        map[string]string
}

func (f *fakeStore) ListFiles(_ context.Context, dir string) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.listed = append(f.listed, dir)
	return f.listing[dir], nil
}

func (f *fakeStore) DownloadTo(_ context.Context, key, dst string) error {
	f.mu.Lock()
	f.downloaded = append(f.downloaded, key)
	body, ok := f.objects[key]
	f.mu.Unlock()
	if !ok {
		return errors.New("not found")
	}
	return os.WriteFile(dst, []byte(body), 0o600)
}

func (f *fakeStore) Put(_ context.Context, key, localPath, contentType string) error {
	body, err := os.ReadFile(localPath)
	if err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.put == nil {
		f.put = map[string]string{}
	}
	f.put[key] = contentType + ":" + string(body)
	return nil
}

func TestSourceIsReadFromTheStore(t *testing.T) {
	store := &fakeStore{objects: map[string]string{"public/tracks/t/audio/original.mp3": "mp3"}}
	r := &Renderer{Store: store}
	dst := filepath.Join(t.TempDir(), "source.mp3")
	if err := r.downloadSource(t.Context(), "public/tracks/t/audio/original.mp3", dst); err != nil {
		t.Fatalf("downloadSource: %v", err)
	}
	body, err := os.ReadFile(dst)
	if err != nil || string(body) != "mp3" {
		t.Fatalf("source = %q, %v", body, err)
	}
}

func TestThemeKeysAreListedFromTheStore(t *testing.T) {
	clearListCache()
	store := &fakeStore{listing: map[string][]string{
		"private/bg-list-test/calm": {
			"private/bg-list-test/calm/b.mp4",
			"private/bg-list-test/calm/readme.txt",
			"private/bg-list-test/calm/a.MP4",
		},
	}}
	keys, err := listThemeKeys(t.Context(), store, "private/bg-list-test/calm")
	if err != nil {
		t.Fatalf("listThemeKeys: %v", err)
	}
	want := []string{"private/bg-list-test/calm/b.mp4", "private/bg-list-test/calm/a.MP4"}
	if !reflect.DeepEqual(keys, want) {
		t.Errorf("keys = %v, want %v", keys, want)
	}
	if !reflect.DeepEqual(store.listed, []string{"private/bg-list-test/calm"}) {
		t.Errorf("listed = %v", store.listed)
	}
}

func TestAnEmptyThemeIsUnknown(t *testing.T) {
	clearListCache()
	store := &fakeStore{}
	_, err := ListAndConcatBackgrounds(t.Context(), BackgroundsInput{
		Store:       store,
		Prefix:      "private/bg-empty-test",
		Theme:       "none",
		VideoID:     "v",
		DurationSec: 5,
		TempDir:     t.TempDir(),
	})
	if !errors.Is(err, ErrUnknownTheme) {
		t.Fatalf("err = %v, want ErrUnknownTheme", err)
	}
	if !reflect.DeepEqual(store.listed, []string{"private/bg-empty-test/none"}) {
		t.Errorf("listed = %v", store.listed)
	}
}

func TestPickedBackgroundsAreDownloadedFromTheStore(t *testing.T) {
	store := &fakeStore{objects: map[string]string{"k/a.mp4": "a", "k/b.mp4": "b"}}
	paths, err := downloadAll(t.Context(), store, []string{"k/b.mp4", "k/a.mp4"}, t.TempDir())
	if err != nil {
		t.Fatalf("downloadAll: %v", err)
	}
	for i, want := range []string{"b", "a"} {
		body, err := os.ReadFile(paths[i])
		if err != nil || string(body) != want {
			t.Errorf("clip %d = %q, %v; want %q", i, body, err, want)
		}
	}
}

func TestReelIsWrittenToTheStoreAndServedFromThePublicBase(t *testing.T) {
	store := &fakeStore{}
	r := &Renderer{Store: store, OutputPublicBase: "https://cdn.example.test/"}
	src := filepath.Join(t.TempDir(), "reel.mp4")
	if err := os.WriteFile(src, []byte("mp4"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := r.uploadOutput(t.Context(), src, "public/share/video/v.mp4"); err != nil {
		t.Fatalf("uploadOutput: %v", err)
	}
	if got := store.put["public/share/video/v.mp4"]; got != "video/mp4:mp4" {
		t.Errorf("stored = %q", got)
	}
	if got := r.buildOutputURL("public/share/video/v.mp4"); got != "https://cdn.example.test/public/share/video/v.mp4" {
		t.Errorf("url = %q", got)
	}
}
