package assethashes

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
)

type fakeCatalog struct {
	variants []catalog.TranscriptAsset
	upserted []catalog.TranscriptAsset
}

func (c *fakeCatalog) TranscriptVariants(context.Context) ([]catalog.TranscriptAsset, error) {
	return c.variants, nil
}

func (c *fakeCatalog) UpsertTranscriptHashes(_ context.Context, a []catalog.TranscriptAsset) error {
	c.upserted = a
	return nil
}

type fakeFiles map[string]bool

func (f fakeFiles) Exists(_ context.Context, p string) (bool, error) { return f[p], nil }

type fakeHasher struct{ err error }

func (h fakeHasher) HashFile(_ context.Context, p string) (string, error) {
	return "sha:" + filepath.Base(p), h.err
}

func TestRunHashesPresentTranscriptsAndCountsMissingOnes(t *testing.T) {
	cat := &fakeCatalog{variants: []catalog.TranscriptAsset{
		{Path: "public/tracks/t1/transcripts/ru.json", TrackID: "t1", Language: "ru"},
		{Path: "public/tracks/t2/transcripts/en.json", TrackID: "t2", Language: "en"},
	}}
	uc := UseCase{
		Catalog: cat,
		Files:   fakeFiles{filepath.Join("/out", "public/tracks/t1/transcripts/ru.json"): true},
		Hasher:  fakeHasher{},
		OutDir:  "/out",
	}
	res, err := uc.Run(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if res != (Result{Variants: 2, Hashed: 1, Missing: 1}) {
		t.Fatalf("result %+v", res)
	}
	want := []catalog.TranscriptAsset{{Path: "public/tracks/t1/transcripts/ru.json", TrackID: "t1", Language: "ru", SHA256: "sha:ru.json"}}
	if !reflect.DeepEqual(cat.upserted, want) {
		t.Fatalf("upserted %+v", cat.upserted)
	}
}

func TestRunWritesNothingWhenAHashFails(t *testing.T) {
	cat := &fakeCatalog{variants: []catalog.TranscriptAsset{{Path: "a.json"}}}
	boom := errors.New("boom")
	uc := UseCase{Catalog: cat, Files: fakeFiles{filepath.Join("/out", "a.json"): true}, Hasher: fakeHasher{err: boom}, OutDir: "/out"}
	if _, err := uc.Run(t.Context()); !errors.Is(err, boom) {
		t.Fatalf("err = %v", err)
	}
	if cat.upserted != nil {
		t.Fatal("hashes were written after a failure")
	}
}
