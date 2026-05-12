package commit

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/extractmeta"
	domaincatalog "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/pipeline"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/transcript"
	audioport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/audio"
	catalogport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/catalog"
	fsport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/fs"
	lakeport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/lake"
	transcriptport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/transcript"
)

// fakeRegistry minimally implements lakeport.Registry. Only the methods
// commit.Run hits are real; the rest panic so misuse surfaces fast.
type fakeRegistry struct {
	lakeport.Registry
	stages   map[string]lakeport.StageRow
	setCalls []setStageCall
}

type setStageCall struct {
	id     track.Id
	key    pipeline.Key
	status pipeline.Status
	err    string
}

func newFakeRegistry() *fakeRegistry {
	return &fakeRegistry{stages: map[string]lakeport.StageRow{}}
}

func stageKey(key pipeline.Key) string { return string(key.Stage) + "|" + key.Variant }

func (r *fakeRegistry) TryClaimStage(_ context.Context, _ track.Id, _ pipeline.Key) (bool, error) {
	return true, nil
}
func (r *fakeRegistry) GetStage(_ context.Context, _ track.Id, key pipeline.Key) (lakeport.StageRow, bool, error) {
	row, ok := r.stages[stageKey(key)]
	return row, ok, nil
}
func (r *fakeRegistry) SetStage(_ context.Context, id track.Id, key pipeline.Key, status pipeline.Status, payload []byte, errMessage string) error {
	r.setCalls = append(r.setCalls, setStageCall{id, key, status, errMessage})
	r.stages[stageKey(key)] = lakeport.StageRow{Key: key, Status: status, Payload: payload, Error: errMessage}
	return nil
}

// fakeAudio satisfies audio.Store; only the path getter commit needs.
type fakeAudio struct {
	audioport.Store
	publicPath string
}

func (a *fakeAudio) PublicAudioPath(track.Id) string { return a.publicPath }

// fakeFS — plain map of paths → exists.
type fakeFS struct {
	exists map[string]bool
}

func (f *fakeFS) Exists(_ context.Context, p string) (bool, error) { return f.exists[p], nil }

var _ fsport.Existence = (*fakeFS)(nil)

// fakeTranscripts satisfies transcript.Store; commit reads PublicTranscriptKey
// + ReadReviewed.
type fakeTranscripts struct {
	transcriptport.Store
	reviewed transcript.Reviewed
	readErr  error
}

func (t *fakeTranscripts) PublicTranscriptKey(id track.Id, lang string) string {
	return "public/tracks/" + string(id) + "/transcripts/" + lang + ".json"
}
func (t *fakeTranscripts) ReadReviewed(_ context.Context, _ track.Id, _ string) (transcript.Reviewed, error) {
	if t.readErr != nil {
		return transcript.Reviewed{}, t.readErr
	}
	return t.reviewed, nil
}

// fakeCatalog implements CommitRepository. SaveTrack records the call so a
// happy-path test can assert it ran; LookupIDByName is the validation gate.
type fakeCatalog struct {
	catalogport.CommitRepository
	knownNames     map[string]string // "kind|name|lang" → id
	saveCalls      int
	lastTrackRow   domaincatalog.TrackRow
	lastVariantRow domaincatalog.VariantRow
	lastRefs       []domaincatalog.TrackReference
}

func nameKey(kind domaincatalog.Kind, name, lang string) string {
	return string(kind) + "|" + name + "|" + lang
}
func (c *fakeCatalog) LookupIDByName(_ context.Context, kind domaincatalog.Kind, name, lang string) (string, bool, error) {
	id, ok := c.knownNames[nameKey(kind, name, lang)]
	return id, ok, nil
}
func (c *fakeCatalog) GetDict(_ context.Context, _ domaincatalog.Kind, _ string) (domaincatalog.DictEntry, bool, error) {
	return domaincatalog.DictEntry{}, false, nil
}
func (c *fakeCatalog) SaveTrack(_ context.Context, t domaincatalog.TrackRow, v domaincatalog.VariantRow, refs []domaincatalog.TrackReference) error {
	c.saveCalls++
	c.lastTrackRow, c.lastVariantRow, c.lastRefs = t, v, refs
	return nil
}

// builds an extractmeta.Result that's complete, then mutators tweak it.
func happyResult() extractmeta.Result {
	return extractmeta.Result{
		Title:        "Bombay Lecture",
		Languages:    []string{"en"},
		Date:         "1974-10-20",
		AuthorName:   "Prabhupada",
		LocationName: "Bombay",
		KindTag:      "morning_walk",
	}
}

// happyTranscript returns one with a single block — survives the
// len(blocks)>0 invariant.
func happyTranscript() transcript.Reviewed {
	return transcript.Reviewed{
		TrackId:  "track_test12345",
		Language: "en",
		Blocks:   []transcript.Block{transcript.ParagraphBlock{}},
	}
}

func happyAudioInfo() audioport.Info {
	return audioport.Info{
		DurationMs: 60_000, SizeBytes: 480_000,
		Bitrate: 64, Channels: 2, SampleRate: 44_100,
	}
}

type harness struct {
	reg   *fakeRegistry
	cat   *fakeCatalog
	uc    UseCase
	track track.Id
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	id := track.Id("track_test12345")
	reg := newFakeRegistry()
	cat := &fakeCatalog{
		knownNames: map[string]string{
			nameKey(domaincatalog.KindAuthor, "Prabhupada", "en"):   "author_pra",
			nameKey(domaincatalog.KindLocation, "Bombay", "en"):     "location_bom",
			nameKey(domaincatalog.KindSource, "BG", "en"):           "source_bg",
		},
	}
	tmp := t.TempDir()
	publicMP3 := filepath.Join(tmp, "public/tracks", string(id), "audio/original.mp3")
	transcripts := &fakeTranscripts{reviewed: happyTranscript()}
	return &harness{
		reg: reg,
		cat: cat,
		uc: UseCase{
			Registry:    reg,
			Audio:       &fakeAudio{publicPath: publicMP3},
			Transcripts: transcripts,
			Catalog:     cat,
			FS: &fakeFS{exists: map[string]bool{
				publicMP3: true,
				filepath.Join(tmp, "public/tracks", string(id), "transcripts/en.json"): true,
			}},
			OutDir: tmp,
		},
		track: id,
	}
}

// seedMetadata writes the extractmeta.Result payload into the metadata
// stage so commit.Run can pick it up.
func (h *harness) seedMetadata(t *testing.T, mut func(*extractmeta.Result)) {
	t.Helper()
	res := happyResult()
	res.Audio = happyAudioInfo()
	if mut != nil {
		mut(&res)
	}
	body, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	h.reg.stages[stageKey(pipeline.Key{Stage: pipeline.StageMetadataExtracted})] = lakeport.StageRow{
		Key: pipeline.Key{Stage: pipeline.StageMetadataExtracted}, Status: pipeline.StatusDone, Payload: body,
	}
}

func TestCommitHappyPath(t *testing.T) {
	h := newHarness(t)
	h.seedMetadata(t, nil)
	res, err := h.uc.Run(context.Background(), h.track, "en")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !res.OK {
		t.Fatalf("expected OK=true, got %+v", res)
	}
	if h.cat.saveCalls != 1 {
		t.Errorf("SaveTrack called %d times, want 1", h.cat.saveCalls)
	}
	if h.cat.lastTrackRow.AuthorID != "author_pra" {
		t.Errorf("AuthorID = %q, want author_pra", h.cat.lastTrackRow.AuthorID)
	}
	if h.cat.lastVariantRow.Title != "Bombay Lecture" {
		t.Errorf("Title = %q", h.cat.lastVariantRow.Title)
	}
}

func TestCommitRefusesUnknownAuthor(t *testing.T) {
	h := newHarness(t)
	h.seedMetadata(t, func(r *extractmeta.Result) {
		r.AuthorName = "GhostName"
	})
	res, _ := h.uc.Run(context.Background(), h.track, "en")
	if res.OK {
		t.Fatal("expected refusal on unknown author name")
	}
	if !containsAny(res.Invalid, "author") {
		t.Errorf("Invalid does not mention author: %+v", res.Invalid)
	}
}

func TestCommitRefusesEmptyTranscript(t *testing.T) {
	h := newHarness(t)
	// Strip blocks → ReadReviewed returns empty Reviewed.
	h.uc.Transcripts = &fakeTranscripts{reviewed: transcript.Reviewed{}}
	h.seedMetadata(t, nil)
	res, _ := h.uc.Run(context.Background(), h.track, "en")
	if res.OK {
		t.Fatal("expected refusal on empty transcript")
	}
	if !containsAny(res.Invalid, "no blocks") {
		t.Errorf("Invalid does not mention no blocks: %+v", res.Invalid)
	}
}

func TestCommitRefusesMissingTranscriptFile(t *testing.T) {
	h := newHarness(t)
	// Drop the transcript file from FS so the existence check fails.
	h.uc.FS = &fakeFS{exists: map[string]bool{
		h.uc.Audio.PublicAudioPath(h.track): true,
	}}
	h.seedMetadata(t, nil)
	res, _ := h.uc.Run(context.Background(), h.track, "en")
	if res.OK {
		t.Fatal("expected refusal on missing transcript file")
	}
	if !containsAny(res.Invalid, "transcript") {
		t.Errorf("Invalid does not mention transcript: %+v", res.Invalid)
	}
}

func TestCommitRefusesZeroDuration(t *testing.T) {
	h := newHarness(t)
	h.seedMetadata(t, func(r *extractmeta.Result) {
		r.Audio = audioport.Info{
			DurationMs: 0,
			SizeBytes:  480_000,
			Bitrate:    64,
		}
	})
	res, _ := h.uc.Run(context.Background(), h.track, "en")
	if res.OK {
		t.Fatal("expected refusal on duration=0")
	}
	if !containsAny(res.Invalid, "duration") {
		t.Errorf("Invalid does not mention duration: %+v", res.Invalid)
	}
}

func TestCommitMetadataStageMissing(t *testing.T) {
	h := newHarness(t)
	// Don't seed metadata — commit must surface "not run yet".
	_, err := h.uc.Run(context.Background(), h.track, "en")
	if err == nil {
		t.Fatal("expected error when metadata stage absent")
	}
	if !strings.Contains(err.Error(), "metadata_extract") {
		t.Errorf("error doesn't mention metadata_extract: %v", err)
	}
}

func containsAny(items []string, sub string) bool {
	for _, it := range items {
		if strings.Contains(it, sub) {
			return true
		}
	}
	return false
}
