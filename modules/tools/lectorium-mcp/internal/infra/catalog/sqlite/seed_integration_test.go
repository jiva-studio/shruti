package sqlitecatalog

import (
	"context"
	"os"
	"testing"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/catalog"
)

// curatedOnboardingTopics is the seed list for onboarding.topics. Kept here so
// the integration test below can assert every id resolves against the real
// catalog before we publish it.
var curatedOnboardingTopics = []string{
	"topic_GwCShbOKUcqG", // Law of karma
	"topic_y6jK0U4tBkQm", // Reincarnation
	"topic_1zZiOn2gui20", // The soul
	"topic_6K9FDwLW0oeB", // Self-realization
	"topic_TcxTwZyg5WdU", // Absolute Truth
	"topic_VcfGB0EJzb5Y", // Bhagavad-gita
	"topic_oKQYNp36R9gH", // Mantra meditation
	"topic_kzFGnExmbBTR", // Mind & consciousness
	"topic_ww2SB7ZY5jnW", // Family
	"topic_7MDjb67G0rXz", // Health
	"topic_Hq0MhXQApHyc", // Overcoming suffering
	"topic_PZqdeQ92bUr9", // Relationship with God
}

// TestSeedAgainstLakeCatalog opens a COPY of the real catalog DB (path in
// LECTORIUM_LAKE_DB), confirms the migration adds settings, and verifies
// every curated onboarding topic id exists. Skipped unless the env var is set
// (so it never runs in CI without the data file). Does NOT publish.
func TestSeedAgainstLakeCatalog(t *testing.T) {
	path := os.Getenv("LECTORIUM_LAKE_DB")
	if path == "" {
		t.Skip("set LECTORIUM_LAKE_DB to a copy of current.db to run this")
	}
	ctx := context.Background()
	repo, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("open lake db: %v", err)
	}
	defer repo.Close()

	for _, id := range curatedOnboardingTopics {
		_, ok, err := repo.GetDict(ctx, catalog.KindTopic, id)
		if err != nil {
			t.Fatalf("GetDict %s: %v", id, err)
		}
		if !ok {
			t.Errorf("curated topic %s not found in catalog", id)
		}
	}

	if err := repo.SetSetting(ctx, "onboarding.topics", `["topic_GwCShbOKUcqG"]`); err != nil {
		t.Fatalf("set settings: %v", err)
	}
	v, ok, err := repo.GetSetting(ctx, "onboarding.topics")
	if err != nil || !ok || v != `["topic_GwCShbOKUcqG"]` {
		t.Fatalf("settings round-trip: v=%q ok=%v err=%v", v, ok, err)
	}
}
