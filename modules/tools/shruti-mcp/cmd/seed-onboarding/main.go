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
	"errors"
	"fmt"
	"log"
	"os"

	configregistry "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/config/registry"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
	sqlitecatalog "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/catalog/sqlite"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	if len(os.Args) < 3 {
		return errors.New("usage: seed-onboarding <current.db> '<json array of topic ids>'")
	}
	path, value := os.Args[1], os.Args[2]
	ctx := context.Background()

	// Open = run applyLocalMigrations (creates settings + daily_wisdom, records
	// the 006 scheme-bump row).
	repo, err := sqlitecatalog.Open(ctx, path)
	if err != nil {
		return fmt.Errorf("open/migrate: %w", err)
	}
	defer repo.Close()

	scheme, err := repo.Scheme(ctx)
	if err != nil {
		return fmt.Errorf("read scheme: %w", err)
	}
	fmt.Printf("scheme after migrate: %d\n", scheme)

	reg := configregistry.New(configregistry.ValidateDeps{
		TopicExists: func(ctx context.Context, id string) (bool, error) {
			_, ok, err := repo.GetDict(ctx, catalog.KindTopic, id)
			return ok, err
		},
	})
	if err := reg.Register(configregistry.OnboardingTopicsDescriptor()); err != nil {
		return fmt.Errorf("register descriptor: %w", err)
	}

	if err := reg.Validate(ctx, "onboarding.topics", []byte(value)); err != nil {
		return fmt.Errorf("validate onboarding.topics: %w", err)
	}
	if err := repo.SetSetting(ctx, "onboarding.topics", value); err != nil {
		return fmt.Errorf("set setting: %w", err)
	}

	got, ok, err := repo.GetSetting(ctx, "onboarding.topics")
	if err != nil {
		return fmt.Errorf("read back: %w", err)
	}
	var ids []string
	_ = json.Unmarshal([]byte(got), &ids)
	fmt.Printf("seeded onboarding.topics (ok=%v, %d ids): %s\n", ok, len(ids), got)
	return nil
}
