package covergen

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"strings"
	"testing"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/imagegen"
)

func tinyJPEG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	img.Set(0, 0, color.RGBA{R: 200, G: 150, B: 60, A: 255})
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatalf("encode fixture: %v", err)
	}
	return buf.Bytes()
}

type fakeRepo struct{ cover string }

func (r *fakeRepo) CoverSubject(context.Context, string, string) (Subject, bool, error) {
	return Subject{Name: "Садху-санга", Desc: "Ретрит 2011"}, true, nil
}
func (r *fakeRepo) SetCover(_ context.Context, _, key string) error { r.cover = key; return nil }

type fakeImages struct {
	out    []byte
	prompt string
	refs   []imagegen.Reference
}

func (f *fakeImages) Generate(_ context.Context, prompt string, refs ...imagegen.Reference) ([]byte, string, error) {
	f.prompt, f.refs = prompt, refs
	return f.out, "image/jpeg", nil
}

type fakeStore struct {
	existing map[string][]byte
	put      map[string][]byte
}

func (s *fakeStore) Name() string   { return "fake" }
func (s *fakeStore) Bucket() string { return "fake" }
func (s *fakeStore) Put(_ context.Context, key, _ string, body io.Reader, _ int64) error {
	b, err := io.ReadAll(body)
	if err != nil {
		return err
	}
	if s.put == nil {
		s.put = map[string][]byte{}
	}
	s.put[key] = b
	return nil
}
func (s *fakeStore) GetJSON(context.Context, string, any) (bool, error) { return false, nil }
func (s *fakeStore) Get(_ context.Context, key string) ([]byte, bool, error) {
	b, ok := s.existing[key]
	return b, ok, nil
}
func (s *fakeStore) Head(context.Context, string) (int64, string, bool, error) {
	return 0, "", false, nil
}

func newUseCase(t *testing.T, existing map[string][]byte) (UseCase, *fakeImages, *fakeStore, *fakeRepo) {
	t.Helper()
	img := &fakeImages{out: tinyJPEG(t)}
	store := &fakeStore{existing: existing}
	repo := &fakeRepo{}
	return UseCase{
		Repo:     repo,
		Prefix:   "public/collections",
		Images:   img,
		Uploader: store,
		Style:    "warm saffron palette",
	}, img, store, repo
}

func TestGenerateDrawsFreshWithoutRestyle(t *testing.T) {
	uc, img, _, repo := newUseCase(t, nil)
	key, err := uc.Generate(t.Context(), "pack_1", "ru", "")
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if key != "public/collections/pack_1/cover.jpg" || repo.cover != key {
		t.Fatalf("cover key not stored: %q / %q", key, repo.cover)
	}
	if len(img.refs) != 0 {
		t.Fatalf("no reference expected, got %d", len(img.refs))
	}
	if strings.Contains(img.prompt, "Repaint") {
		t.Fatalf("restyle preamble leaked into a plain generate: %q", img.prompt)
	}
}

func TestRestylePassesTheCurrentCover(t *testing.T) {
	current := tinyJPEG(t)
	uc, img, _, _ := newUseCase(t, map[string][]byte{
		"public/collections/pack_1/cover.jpg": current,
	})
	if _, err := uc.Generate(t.Context(), "pack_1", "ru", "", Restyle()); err != nil {
		t.Fatalf("generate: %v", err)
	}
	if len(img.refs) != 1 || !bytes.Equal(img.refs[0].Data, current) {
		t.Fatalf("current cover was not handed to the model: %d refs", len(img.refs))
	}
	if !strings.HasPrefix(img.prompt, "Repaint the attached image") {
		t.Fatalf("prompt does not say what the attachment is for: %q", img.prompt)
	}
	if !strings.Contains(img.prompt, "warm saffron palette") {
		t.Fatalf("house style dropped from the prompt: %q", img.prompt)
	}
}

// Restyle on an entity that has no art yet must still produce a cover rather
// than fail — that is the case for the collections missing one entirely.
func TestRestyleWithoutAnExistingCoverStillDraws(t *testing.T) {
	uc, img, store, _ := newUseCase(t, nil)
	key, err := uc.Generate(t.Context(), "pack_2", "ru", "", Restyle())
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if len(img.refs) != 0 {
		t.Fatalf("nothing to reference, got %d", len(img.refs))
	}
	if _, ok := store.put[key]; !ok {
		t.Fatalf("cover was not uploaded under %q", key)
	}
}
