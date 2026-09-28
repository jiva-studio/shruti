package runingest

import (
	"context"
	"errors"
	"log/slog"
	"testing"

	"github.com/jiva-studio/shruti/pipeline/blobpath"
)

// fakeImages answers from a table of URLs and remembers what it was asked.
type fakeImages struct {
	images map[string]string
	asked  []string
}

func (f *fakeImages) FetchImage(_ context.Context, url string) ([]byte, string, error) {
	f.asked = append(f.asked, url)
	body, ok := f.images[url]
	if !ok {
		return nil, "", errors.New("cover GET: HTTP 404")
	}
	return []byte(body), "", nil
}

// typedBlob keeps the content type each object was stored with.
type typedBlob struct {
	*fakeBlob
	types map[string]string
}

func (b *typedBlob) Put(ctx context.Context, key string, body []byte, contentType string) error {
	b.types[key] = contentType
	return b.fakeBlob.Put(ctx, key, body, contentType)
}

func TestACoverFallsBackToTheAlwaysPresentStill(t *testing.T) {
	images := &fakeImages{images: map[string]string{
		"https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg": "still",
	}}
	blob := &typedBlob{fakeBlob: newBlob(), types: map[string]string{}}
	s := New(Deps{Blob: blob, Covers: images})

	key := s.storeCover(t.Context(), slog.Default(), "https://www.youtube.com/watch?v=abcdefghijk", "hash1")
	if key != blobpath.CoverKey("hash1") {
		t.Fatalf("key = %q, want the public cover key", key)
	}
	want := []string{
		"https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg",
		"https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg",
	}
	if len(images.asked) != 2 || images.asked[0] != want[0] || images.asked[1] != want[1] {
		t.Errorf("asked %v, want the 16:9 variants in order", images.asked)
	}
	if string(blob.objects[key]) != "still" || blob.types[key] != "image/jpeg" {
		t.Errorf("stored %q as %q", blob.objects[key], blob.types[key])
	}
}

func TestACoverIsOnlyLookedForOnYouTube(t *testing.T) {
	images := &fakeImages{}
	s := New(Deps{Blob: newBlob(), Covers: images})
	if key := s.storeCover(t.Context(), slog.Default(), "https://audioveda.ru/1.mp3", "hash1"); key != "" {
		t.Errorf("key = %q for a source with no thumbnail", key)
	}
	if len(images.asked) != 0 {
		t.Errorf("asked %v", images.asked)
	}
}

func TestNoImageFetcherMeansNoCover(t *testing.T) {
	s := New(Deps{Blob: newBlob()})
	if key := s.storeCover(t.Context(), slog.Default(), "https://youtu.be/abcdefghijk", "hash1"); key != "" {
		t.Errorf("key = %q with no image fetcher", key)
	}
}

func TestAMissingCoverLeavesNoArt(t *testing.T) {
	blob := newBlob()
	s := New(Deps{Blob: blob, Covers: &fakeImages{}})
	if key := s.storeCover(t.Context(), slog.Default(), "https://youtu.be/abcdefghijk", "hash1"); key != "" {
		t.Errorf("key = %q when neither still exists", key)
	}
	if len(blob.objects) != 0 {
		t.Errorf("stored %d objects", len(blob.objects))
	}
}
