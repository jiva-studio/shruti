// Command seed-onboarding migrates a catalog current.db (open runs the
// additive migrations + scheme bump) and seeds the `onboarding.topics`
// setting, validated through the same config registry the MCP config.set tool
// uses. One-off authoring utility for the onboarding curated-topics list.
//
//	go run ./cmd/seed-onboarding <path/to/current.db> '["topic_x","topic_y"]'
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"

	configregistry "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/config/registry"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/catalog"
	sqlitecatalog "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/catalog/sqlite"
)

func main() {
	if len(os.Args) < 3 {
		log.Fatalf("usage: seed-onboarding <current.db> '<json array of topic ids>'")
	}
	path, value := os.Args[1], os.Args[2]
	ctx := context.Background()

	// Open = run applyLocalMigrations (creates settings + daily_wisdom, records
	// the 006 scheme-bump row).
	repo, err := sqlitecatalog.Open(ctx, path)
	if err != nil {
		log.Fatalf("open/migrate: %v", err)
	}
	defer repo.Close()

	scheme, err := repo.Scheme(ctx)
	if err != nil {
		log.Fatalf("read scheme: %v", err)
	}
	fmt.Printf("scheme after migrate: %d\n", scheme)

	reg := configregistry.New(configregistry.ValidateDeps{
		TopicExists: func(ctx context.Context, id string) (bool, error) {
			_, ok, err := repo.GetDict(ctx, catalog.KindTopic, id)
			return ok, err
		},
	})
	reg.Register(configregistry.OnboardingTopicsDescriptor())

	if err := reg.Validate(ctx, "onboarding.topics", []byte(value)); err != nil {
		log.Fatalf("validate onboarding.topics: %v", err)
	}
	if err := repo.SetSetting(ctx, "onboarding.topics", value); err != nil {
		log.Fatalf("set setting: %v", err)
	}

	got, ok, err := repo.GetSetting(ctx, "onboarding.topics")
	if err != nil {
		log.Fatalf("read back: %v", err)
	}
	var ids []string
	_ = json.Unmarshal([]byte(got), &ids)
	fmt.Printf("seeded onboarding.topics (ok=%v, %d ids): %s\n", ok, len(ids), got)
}
