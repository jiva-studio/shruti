// Package scheduler wires cron entries: one per enabled campaign plus a
// periodic catalog refresh. Actual work is delegated to the runner.
package scheduler

import (
	"context"
	"log/slog"
	"time"

	"github.com/robfig/cron/v3"

	"github.com/jiva-studio/lectorium-social-poster/internal/catalog"
	"github.com/jiva-studio/lectorium-social-poster/internal/config"
	"github.com/jiva-studio/lectorium-social-poster/internal/runner"
)

// runTimeout caps a single campaign run (select → share-audio cut → publish
// to every target). share-audio waits up to ~3 min; add headroom.
const runTimeout = 8 * time.Minute

type Scheduler struct {
	cron   *cron.Cron
	cfg    *config.Config
	cat    *catalog.Manager
	runner *runner.Runner
	log    *slog.Logger
}

func New(cfg *config.Config, cat *catalog.Manager, r *runner.Runner, log *slog.Logger) *Scheduler {
	return &Scheduler{cron: cron.New(), cfg: cfg, cat: cat, runner: r, log: log}
}

// Start registers all cron entries and begins ticking. Jobs use a fresh
// timeout context each fire (not the caller's) so shutdown of the boot ctx
// doesn't kill an in-flight post; graceful stop is via Stop().
func (s *Scheduler) Start() error {
	if _, err := s.cron.AddFunc(s.cfg.Catalog.Refresh, s.refreshJob); err != nil {
		return err
	}
	s.log.Info("scheduled_catalog_refresh", "spec", s.cfg.Catalog.Refresh)

	for _, cp := range s.cfg.Campaigns {
		if !cp.IsEnabled() {
			s.log.Info("campaign_disabled", "campaign", cp.Name)
			continue
		}
		name := cp.Name
		if _, err := s.cron.AddFunc(cp.Schedule, func() { s.campaignJob(name) }); err != nil {
			return err
		}
		s.log.Info("scheduled_campaign", "campaign", name, "spec", cp.Schedule, "targets", cp.Targets)
	}

	s.cron.Start()
	return nil
}

func (s *Scheduler) refreshJob() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	if err := s.cat.RefreshAll(ctx); err != nil {
		s.log.Error("catalog_refresh_failed", "err", err.Error())
		return
	}
	s.log.Info("catalog_refreshed")
}

func (s *Scheduler) campaignJob(name string) {
	ctx, cancel := context.WithTimeout(context.Background(), runTimeout)
	defer cancel()
	rep, err := s.runner.Run(ctx, name)
	if err != nil {
		s.log.Error("campaign_run_failed", "campaign", name, "err", err.Error())
		return
	}
	s.log.Info("campaign_run", "campaign", name, "content_id", rep.ContentID, "targets", len(rep.Targets))
}

// Stop halts the scheduler and waits for running jobs to finish.
func (s *Scheduler) Stop() {
	ctx := s.cron.Stop()
	<-ctx.Done()
}
