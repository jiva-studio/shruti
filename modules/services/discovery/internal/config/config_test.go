package config_test

import (
	"testing"
	"time"

	"github.com/jiva-studio/lectorium/discovery/internal/config"
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
	t.Setenv("LECTORIUM_DISCOVERY_SCHEDULER_WORKERS", "64")
	cfg := config.Load()
	if cfg.DBMaxConns <= 64 {
		t.Errorf("64 workers got a pool of %d", cfg.DBMaxConns)
	}
}

// Every setting has one name, and it is the same name in the deployment file,
// in compose and here. Translating between a long name outside the container
// and a short one inside cost us a variable that existed in the code and
// nowhere else, and a default that disagreed with compose while both looked
// right on their own.
func TestEverySettingHasOneName(t *testing.T) {
	t.Setenv("LECTORIUM_DISCOVERY_SCHEDULER_WORKERS", "7")
	t.Setenv("DISCOVERY_SCHEDULER_WORKERS", "99")
	if got := config.Load().SchedulerWorkers; got != 7 {
		t.Errorf("workers = %d; the service still answers to the short name", got)
	}
}

// The defaults live here and only here, so compose has nothing to disagree
// with. The model is part of the input hash: a default that differs from what
// production runs shifts every hash and the work already done stops counting.
func TestTheDefaultsAreStatedOnlyInTheCode(t *testing.T) {
	cfg := config.Load()
	for what, got := range map[string]string{
		"model":    cfg.LLMModel,
		"endpoint": cfg.LLMBaseURL,
		"embedder": cfg.EmbedModel,
	} {
		if got == "" {
			t.Errorf("%s has no default; compose used to carry it", what)
		}
	}
	if cfg.LLMModel != "google/gemini-3.1-flash-lite" {
		t.Errorf("model = %q", cfg.LLMModel)
	}
	if cfg.LLMBaseURL != "https://openrouter.ai/api/v1" {
		t.Errorf("endpoint = %q", cfg.LLMBaseURL)
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
	t.Setenv("LECTORIUM_DISCOVERY_SCHEDULER_ENABLED", "true")
	t.Setenv("LECTORIUM_DISCOVERY_SCHEDULER_WORKERS", "9")
	t.Setenv("LECTORIUM_DISCOVERY_CRAWL_DELAY", "3s")
	t.Setenv("LECTORIUM_DISCOVERY_MAX_BODY_BYTES", "4096")

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
	t.Setenv("LECTORIUM_DISCOVERY_CRAWL_DELAY", "soon")
	t.Setenv("LECTORIUM_DISCOVERY_SCHEDULER_WORKERS", "lots")
	t.Setenv("LECTORIUM_DISCOVERY_MAX_BODY_BYTES", "-1")
	t.Setenv("LECTORIUM_DISCOVERY_SCHEDULER_ENABLED", "perhaps")

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

// Without a key the service still fetches, extracts and stores; it just cannot
// say what anything means. It has to say what is missing.
func TestAMissingModelIsNamedNotGuessed(t *testing.T) {
	t.Setenv("LECTORIUM_DISCOVERY_LLM_API_KEY", "")
	ok, missing := config.Load().NormalizerReady()
	if ok || len(missing) != 1 {
		t.Errorf("ready=%v missing=%v", ok, missing)
	}

	t.Setenv("LECTORIUM_DISCOVERY_LLM_API_KEY", "k")
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
