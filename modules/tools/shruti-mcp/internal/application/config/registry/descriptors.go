package configregistry

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// OnboardingTopicsDescriptor declares `onboarding.topics`: the curated, ordered
// list of topic ids shown on the first onboarding screen's topic picker.
func OnboardingTopicsDescriptor() Descriptor {
	return Descriptor{
		Key: "onboarding.topics",
		Description: "Curated, ordered list of topic ids for the onboarding topic picker. " +
			"Value is a JSON array of topic ids (e.g. [\"topic_abc\",\"topic_def\"]). " +
			"Each id must reference an existing topic. The mobile app shows these as " +
			"selectable chips on the first launch; it falls back to popularity when unset.",
		Schema: json.RawMessage(`{
			"type": "array",
			"minItems": 1,
			"items": { "type": "string", "pattern": "^topic_" },
			"uniqueItems": true
		}`),
		Validate: validateOnboardingTopics,
	}
}

func validateOnboardingTopics(ctx context.Context, raw []byte, deps ValidateDeps) error {
	var ids []string
	if err := json.Unmarshal(raw, &ids); err != nil {
		return fmt.Errorf("value must be a JSON array of topic ids: %w", err)
	}
	if len(ids) == 0 {
		return fmt.Errorf("topic list must not be empty")
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if !strings.HasPrefix(id, "topic_") {
			return fmt.Errorf("invalid topic id %q (must start with \"topic_\")", id)
		}
		if seen[id] {
			return fmt.Errorf("duplicate topic id %q", id)
		}
		seen[id] = true
		if deps.TopicExists == nil {
			continue
		}
		ok, err := deps.TopicExists(ctx, id)
		if err != nil {
			return fmt.Errorf("checking topic %q: %w", id, err)
		}
		if !ok {
			return fmt.Errorf("unknown topic id %q (not in catalog)", id)
		}
	}
	return nil
}
