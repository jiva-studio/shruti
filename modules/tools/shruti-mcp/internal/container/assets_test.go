package container

import (
	"testing"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/config"
)

func TestPublishTargetIsTheBunnyZoneAlone(t *testing.T) {
	targets := buildPublishTargets(config.S3{Bunny: config.BunnyTarget{Zone: "zone", AccessKey: "key"}})
	if len(targets) != 1 {
		t.Fatalf("got %d publish targets, want 1", len(targets))
	}
	if got := targets[0].Name(); got != "bunny" {
		t.Fatalf("publish target = %q, want bunny", got)
	}
}

func TestNoBunnyZoneMeansNoPublishTarget(t *testing.T) {
	if targets := buildPublishTargets(config.S3{}); len(targets) != 0 {
		t.Fatalf("got %d publish targets without a zone, want 0", len(targets))
	}
}
