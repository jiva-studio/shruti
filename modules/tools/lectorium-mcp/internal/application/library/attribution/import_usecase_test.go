package attribution

import (
	"context"
	"testing"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/library"
)

const samplePlan = `
source_id: source_bg
language: ru
verses:
  - tokens: "2.13"
    verse_id: verse_a
    topics:
      - "природа души"
      - "реинкарнация"
    questions:
      - "что такое душа"
  - tokens: "2.20"
    verse_id: verse_b
    topics:
      - "природа души"        # shared with 2.13 → one attribution, two refs
    questions:
      - "что такое душа"      # shared with 2.13 → one attribution, two refs
      - "бессмертна ли душа"
`

func TestImport_AggregatesSharedTextAndIsIdempotent(t *testing.T) {
	ctx := context.Background()
	repo := newFakeRepo()
	uc := UseCase{Repo: repo, Minter: &seqMinter{}, Langs: []string{"ru"}}

	plan, err := ParseImportPlan([]byte(samplePlan))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}

	res, err := uc.Import(ctx, plan)
	if err != nil {
		t.Fatalf("import: %v", err)
	}

	// Unique texts: topics {природа души, реинкарнация} = 2 boost;
	// questions {что такое душа, бессмертна ли душа} = 2 pinned.
	if res.BoostTexts != 2 || res.PinnedTexts != 2 {
		t.Fatalf("text counts: boost=%d pinned=%d (want 2/2)", res.BoostTexts, res.PinnedTexts)
	}
	// First run: all 4 freshly created.
	if res.Created != 4 || res.Existed != 0 {
		t.Fatalf("first run: created=%d existed=%d (want 4/0)", res.Created, res.Existed)
	}
	if len(repo.created) != 4 {
		t.Fatalf("expected 4 attribution rows, got %d", len(repo.created))
	}

	// "природа души" appeared in both verses → one attribution with two
	// verse refs. Find it and check ref count.
	id, found, _ := repo.AttributionFindByText(ctx, library.AttrBoost, "ru", "природа души")
	if !found {
		t.Fatalf("expected boost attribution for shared topic")
	}
	refsForShared := 0
	for _, ra := range repo.refAdds {
		if ra.ID == id {
			refsForShared++
		}
	}
	if refsForShared != 2 {
		t.Fatalf("shared topic should have 2 verse refs, got %d", refsForShared)
	}

	// Second run on the same plan → everything already exists, nothing new.
	res2, err := uc.Import(ctx, plan)
	if err != nil {
		t.Fatalf("re-import: %v", err)
	}
	if res2.Created != 0 || res2.Existed != 4 {
		t.Fatalf("second run: created=%d existed=%d (want 0/4)", res2.Created, res2.Existed)
	}
	if len(repo.created) != 4 {
		t.Fatalf("re-import must not add rows; got %d", len(repo.created))
	}
}

func TestParseImportPlan_RequiresLanguage(t *testing.T) {
	_, err := ParseImportPlan([]byte("source_id: x\nverses: []\n"))
	if err == nil {
		t.Fatal("expected error when language missing")
	}
}

func TestParseImportPlan_VerseNeedsTarget(t *testing.T) {
	_, err := ParseImportPlan([]byte("language: ru\nverses:\n  - tokens: \"1.1\"\n    topics: [x]\n"))
	if err == nil {
		t.Fatal("expected error when verse has neither verse_id nor documents")
	}
}
