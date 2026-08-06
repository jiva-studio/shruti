package config_test

import (
	"testing"
	"time"

	"github.com/jiva-studio/shruti/discovery/internal/config"
)

// Configuration is read once at boot and never again, so a value that quietly
// falls back to a default is a whole deployment behaving differently from the
// file the operator is reading. These are cheap and they are the only thing
// that says the two agree.

func TestDefaultsAreSafe(t *testing.T) {
	cfg := config.Load()

	// Starting the service must not make it fetch anything.
	if cfg.SchedulerEnabled {
		t.Error("the scheduler defaults to on")
	}
	if cfg.DefaultCrawlDelay <= 0 {
		t.Errorf("crawl delay = %v; no gap is a crawler asking as fast as a site can answer", cfg.DefaultCrawlDelay)
	}
	if cfg.MaxBodyBytes <= 0 {
		t.Errorf("body cap = %d", cfg.MaxBodyBytes)
	}
	if cfg.SchedulerWorkers <= 0 {
		t.Errorf("workers = %d", cfg.SchedulerWorkers)
	}
	if cfg.RequestTimeout <= 0 {
		t.Errorf("timeout = %v", cfg.RequestTimeout)
	}
}

// Every step of reading a page has its own timeout and they stack, so a page
// needs a ceiling of its own — and the pool has to be big enough that the
// workers holding those connections do not leave the API queueing behind them.
func TestAPageAndThePoolAreBothBounded(t *testing.T) {
	cfg := config.Load()
	if cfg.PageTimeout <= 0 {
		t.Errorf("page timeout = %v; one page could hold a worker for ever", cfg.PageTimeout)
	}
	if cfg.DBMaxConns < cfg.SchedulerWorkers {
		t.Errorf("pool of %d for %d workers is a queue in front of the database",
			cfg.DBMaxConns, cfg.SchedulerWorkers)
	}
}

// Raising the worker count without raising the pool is the easy mistake, so the
// pool follows rather than waiting to be told.
func TestThePoolFollowsTheWorkerCount(t *testing.T) {
	t.Setenv("DISCOVERY_SCHEDULER_WORKERS", "64")
	cfg := config.Load()
	if cfg.DBMaxConns <= 64 {
		t.Errorf("64 workers got a pool of %d", cfg.DBMaxConns)
	}
}

// The model is part of the input hash, so a default that disagrees with what
// production runs does not merely read pages differently — it shifts every
// hash, and the work already done stops counting.
func TestTheModelDefaultIsTheDeployedOne(t *testing.T) {
	if got := config.Load().LLMModel; got != "google/gemini-3.1-flash-lite" {
		t.Errorf("default model = %q; compose and the env template say google/gemini-3.1-flash-lite", got)
	}
}

// The user agent is how a volunteer archive knows who is reading it and where
// to complain. A crawler without one is an anonymous stranger.
func TestUserAgentNamesUsAndSaysWhereToComplain(t *testing.T) {
	cfg := config.Load()
	if len(cfg.UserAgent) < 10 || !contains(cfg.UserAgent, "http") {
		t.Errorf("user agent = %q, want a name and a contact URL", cfg.UserAgent)
	}
}

func TestEnvironmentOverridesDefaults(t *testing.T) {
	t.Setenv("DISCOVERY_SCHEDULER_ENABLED", "true")
	t.Setenv("DISCOVERY_SCHEDULER_WORKERS", "9")
	t.Setenv("DISCOVERY_CRAWL_DELAY", "3s")
	t.Setenv("DISCOVERY_MAX_BODY_BYTES", "4096")

	cfg := config.Load()
	if !cfg.SchedulerEnabled || cfg.SchedulerWorkers != 9 {
		t.Errorf("scheduler: on=%v workers=%d", cfg.SchedulerEnabled, cfg.SchedulerWorkers)
	}
	if cfg.DefaultCrawlDelay != 3*time.Second {
		t.Errorf("delay = %v", cfg.DefaultCrawlDelay)
	}
	if cfg.MaxBodyBytes != 4096 {
		t.Errorf("body cap = %d", cfg.MaxBodyBytes)
	}
}

// A misspelt value falls back rather than starting the service with nothing.
// Zero here would mean no gap between requests and no cap on a body.
func TestUnreadableValuesFallBack(t *testing.T) {
	t.Setenv("DISCOVERY_CRAWL_DELAY", "soon")
	t.Setenv("DISCOVERY_SCHEDULER_WORKERS", "lots")
	t.Setenv("DISCOVERY_MAX_BODY_BYTES", "-1")
	t.Setenv("DISCOVERY_SCHEDULER_ENABLED", "perhaps")

	cfg := config.Load()
	if cfg.DefaultCrawlDelay <= 0 || cfg.SchedulerWorkers <= 0 || cfg.MaxBodyBytes <= 0 {
		t.Errorf("nonsense became nothing: %+v", cfg)
	}
	if cfg.SchedulerEnabled {
		t.Error("an unreadable flag switched the scheduler on")
	}
}

// Serving needs a database; the single-URL dry run does not, which is why
// asking about one address does not depend on the service being deployed.
func TestOnlyServingRequiresADatabase(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	if err := config.Load().RequireDatabase(); err == nil {
		t.Error("serving without a database was allowed")
	}
	t.Setenv("DATABASE_URL", "postgresql://x/y")
	if err := config.Load().RequireDatabase(); err != nil {
		t.Error(err)
	}
}

// Without a model the service still fetches, extracts and stores; it just
// cannot say what anything means. It has to say which part is missing.
func TestAMissingModelIsNamedNotGuessed(t *testing.T) {
	t.Setenv("DISCOVERY_LLM_BASE_URL", "")
	t.Setenv("DISCOVERY_LLM_API_KEY", "")
	ok, missing := config.Load().NormalizerReady()
	if ok || len(missing) != 2 {
		t.Errorf("ready=%v missing=%v", ok, missing)
	}

	t.Setenv("DISCOVERY_LLM_BASE_URL", "https://example/v1")
	t.Setenv("DISCOVERY_LLM_API_KEY", "k")
	if ok, missing := config.Load().NormalizerReady(); !ok {
		t.Errorf("configured but reported missing %v", missing)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
