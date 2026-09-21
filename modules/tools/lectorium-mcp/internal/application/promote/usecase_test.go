package promote

import (
	"context"
	"testing"

	domaincatalog "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/catalog"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/pending"
)

// --- fakes ---

type fakePending struct {
	rows     map[string]pending.Track
	consumed []string
}

func (f *fakePending) List(_ context.Context, _ pending.ListOpts) ([]pending.Track, error) {
	return nil, nil
}
func (f *fakePending) Get(ctx context.Context, id string) (pending.Track, bool, error) {
	p, ok := f.rows[id]
	return p, ok, nil
}
func (f *fakePending) MarkConsumed(ctx context.Context, id string) (bool, error) {
	if _, ok := f.rows[id]; !ok {
		return false, nil
	}
	f.consumed = append(f.consumed, id)
	return true, nil
}

// fakeCatalog implements catalogport.CommitRepository. dicts holds existing ids;
// names maps (kind, name) → id for LookupIDByName.
type fakeCatalog struct {
	dicts     map[string]domaincatalog.DictEntry // id → entry
	names     map[string]string                  // "kind|name" → id
	saved     *domaincatalog.TrackRow
	savedVar  *domaincatalog.VariantRow
	savedAud  []domaincatalog.AudioRow
	savedRefs []domaincatalog.TrackReference
	saveCalls int
}

func (c *fakeCatalog) GetDict(_ context.Context, _ domaincatalog.Kind, id string) (domaincatalog.DictEntry, bool, error) {
	e, ok := c.dicts[id]
	return e, ok, nil
}
func (c *fakeCatalog) LookupIDByName(_ context.Context, kind domaincatalog.Kind, name, _ string) (string, bool, error) {
	id, ok := c.names[string(kind)+"|"+name]
	return id, ok, nil
}
func (c *fakeCatalog) SaveTrack(_ context.Context, t domaincatalog.TrackRow, v domaincatalog.VariantRow, a []domaincatalog.AudioRow, refs []domaincatalog.TrackReference) error {
	c.saveCalls++
	c.saved = &t
	c.savedVar = &v
	c.savedAud = a
	c.savedRefs = refs
	return nil
}

// unused TrackRepository / read methods.
func (c *fakeCatalog) GetTrack(context.Context, string) (domaincatalog.TrackRow, bool, error) {
	return domaincatalog.TrackRow{}, false, nil
}
func (c *fakeCatalog) GetVariant(context.Context, string, string) (domaincatalog.VariantRow, bool, error) {
	return domaincatalog.VariantRow{}, false, nil
}
func (c *fakeCatalog) GetAudios(context.Context, string, string) ([]domaincatalog.AudioRow, error) {
	return nil, nil
}
func (c *fakeCatalog) GetReferences(context.Context, string) ([]domaincatalog.TrackReference, error) {
	return nil, nil
}
func (c *fakeCatalog) GetTrackTags(context.Context, string) ([]string, error)       { return nil, nil }
func (c *fakeCatalog) UpsertAudio(context.Context, domaincatalog.AudioRow) error    { return nil }
func (c *fakeCatalog) UpsertAudios(context.Context, []domaincatalog.AudioRow) error { return nil }
func (c *fakeCatalog) DeleteTrackVariant(context.Context, string, string) error     { return nil }

func basePending() pending.Track {
	return pending.Track{
		TrackID: "track_x", OwnerID: "user_owner", TitleRaw: "On the Soul",
		AuthorRaw: "Prabhupada", Lang: "en", DateRaw: "1974-06-22",
		TranscriptPath:  "public/tracks/track_x/transcripts/en.json",
		AudioPath:       "public/tracks/track_x/audio/original.mp3",
		AudioDurationMs: 3600000, AudioSizeBytes: 1234,
	}
}

func TestApproveHappyPath_ResolvesNameSetsContributorAndConsumes(t *testing.T) {
	ctx := t.Context()
	fp := &fakePending{rows: map[string]pending.Track{"track_x": basePending()}}
	fc := &fakeCatalog{
		dicts: map[string]domaincatalog.DictEntry{"author_ABC": {ID: "author_ABC"}},
		names: map[string]string{"author|Prabhupada": "author_ABC"},
	}
	uc := UseCase{Pending: fp, Catalog: fc}

	res, err := uc.Approve(ctx, Input{TrackID: "track_x"})
	if err != nil {
		t.Fatalf("approve: %v", err)
	}
	if !res.OK {
		t.Fatalf("expected OK, got %+v", res)
	}
	if fc.saveCalls != 1 {
		t.Fatalf("SaveTrack calls = %d, want 1", fc.saveCalls)
	}
	if fc.saved.AuthorID != "author_ABC" {
		t.Errorf("author resolved to %q, want author_ABC", fc.saved.AuthorID)
	}
	if fc.saved.ContributorUserID != "user_owner" {
		t.Errorf("contributor = %q, want user_owner (from owner_id)", fc.saved.ContributorUserID)
	}
	if fc.saved.ID != "track_x" {
		t.Errorf("track_id changed to %q, want stable track_x", fc.saved.ID)
	}
	if fc.savedVar.TranscriptPath != "public/tracks/track_x/transcripts/en.json" {
		t.Errorf("transcript not zero-copy: %q", fc.savedVar.TranscriptPath)
	}
	if len(fc.savedAud) != 1 || fc.savedAud[0].Path != "public/tracks/track_x/audio/original.mp3" {
		t.Errorf("audio not zero-copy: %+v", fc.savedAud)
	}
	if len(fp.consumed) != 1 || fp.consumed[0] != "track_x" {
		t.Errorf("pending not marked consumed: %v", fp.consumed)
	}
}

func TestApproveRefusesWhenAuthorUnresolved(t *testing.T) {
	ctx := t.Context()
	fp := &fakePending{rows: map[string]pending.Track{"track_x": basePending()}}
	fc := &fakeCatalog{dicts: map[string]domaincatalog.DictEntry{}, names: map[string]string{}}
	uc := UseCase{Pending: fp, Catalog: fc}

	res, err := uc.Approve(ctx, Input{TrackID: "track_x"})
	if err != nil {
		t.Fatalf("approve: %v", err)
	}
	if res.OK {
		t.Fatal("expected refusal (author unresolved)")
	}
	if len(res.Unresolved) == 0 {
		t.Error("expected an unresolved entry for the author")
	}
	if fc.saveCalls != 0 {
		t.Error("SaveTrack must not be called on refusal")
	}
	if len(fp.consumed) != 0 {
		t.Error("pending must not be consumed on refusal")
	}
}

func TestApproveExplicitIdsAndReferencesBuildSortRef(t *testing.T) {
	ctx := t.Context()
	fp := &fakePending{rows: map[string]pending.Track{"track_x": basePending()}}
	fc := &fakeCatalog{
		dicts: map[string]domaincatalog.DictEntry{
			"author_ABC":   {ID: "author_ABC"},
			"location_BOM": {ID: "location_BOM"},
			"source_BG":    {ID: "source_BG", ShortName: map[string]string{"en": "BG"}},
		},
	}
	uc := UseCase{Pending: fp, Catalog: fc}

	res, err := uc.Approve(ctx, Input{
		TrackID:    "track_x",
		AuthorID:   "author_ABC",
		LocationID: "location_BOM",
		References: []Ref{{SourceID: "source_BG", Tokens: "2.13"}},
	})
	if err != nil {
		t.Fatalf("approve: %v", err)
	}
	if !res.OK {
		t.Fatalf("expected OK, got %+v", res)
	}
	if fc.saved.LocationID != "location_BOM" {
		t.Errorf("location = %q", fc.saved.LocationID)
	}
	if len(fc.savedRefs) != 1 || fc.savedRefs[0].SourceID != "source_BG" {
		t.Fatalf("refs = %+v", fc.savedRefs)
	}
	if fc.savedVar.SortReference == nil || *fc.savedVar.SortReference != "BG_000002_000013" {
		got := "<nil>"
		if fc.savedVar.SortReference != nil {
			got = *fc.savedVar.SortReference
		}
		t.Errorf("sort_reference = %q, want BG_000002_000013", got)
	}
}

func TestApproveUnknownPendingReturnsNotFound(t *testing.T) {
	uc := UseCase{Pending: &fakePending{rows: map[string]pending.Track{}}, Catalog: &fakeCatalog{}}
	_, err := uc.Approve(t.Context(), Input{TrackID: "nope"})
	if err != ErrNotFound {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}
