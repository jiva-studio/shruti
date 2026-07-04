// Package runner executes a single campaign end-to-end: select a candidate,
// build the content, then fan out to each target's publisher, recording
// every success in state for idempotency and the not-recently-posted filter.
package runner

import (
	"context"
	"errors"
	"log/slog"
	"math/rand"
	"net/http"
	"sync"
	"time"

	"github.com/jiva-studio/lectorium-social-poster/internal/catalog"
	"github.com/jiva-studio/lectorium-social-poster/internal/config"
	"github.com/jiva-studio/lectorium-social-poster/internal/content"
	"github.com/jiva-studio/lectorium-social-poster/internal/poster"
	"github.com/jiva-studio/lectorium-social-poster/internal/publisher"
	"github.com/jiva-studio/lectorium-social-poster/internal/selector"
	"github.com/jiva-studio/lectorium-social-poster/internal/state"
)

type Runner struct {
	cfg     *config.Config
	sel     *selector.Selector
	builder *content.Builder
	pubs    map[string]publisher.Publisher
	st      *state.State
	log     *slog.Logger

	mu  sync.Mutex
	rng *rand.Rand
}

// TargetResult reports the outcome for one target within a campaign run.
type TargetResult struct {
	Target  string `json:"target"`
	Skipped bool   `json:"skipped,omitempty"`
	Reason  string `json:"reason,omitempty"`
	Ref     string `json:"ref,omitempty"`
	Error   string `json:"error,omitempty"`
}

// Report is the outcome of a campaign run.
type Report struct {
	Campaign  string         `json:"campaign"`
	ContentID string         `json:"content_id,omitempty"`
	Targets   []TargetResult `json:"targets"`
}

// New builds a Runner and its per-target publishers from config.
func New(cfg *config.Config, cat *catalog.Manager, st *state.State, httpc *http.Client, log *slog.Logger) (*Runner, error) {
	pubs, err := buildPublishers(cfg, httpc)
	if err != nil {
		return nil, err
	}
	return &Runner{
		cfg:     cfg,
		sel:     selector.New(cat, st),
		builder: content.NewBuilder(cfg, httpc),
		pubs:    pubs,
		st:      st,
		log:     log,
		rng:     rand.New(rand.NewSource(time.Now().UnixNano())),
	}, nil
}

func buildPublishers(cfg *config.Config, httpc *http.Client) (map[string]publisher.Publisher, error) {
	out := map[string]publisher.Publisher{}
	for name, t := range cfg.Targets {
		switch t.Platform {
		case config.PlatformTelegram:
			out[name] = publisher.NewTelegram(name, t.Token, t.ChatID, httpc)
		case config.PlatformVK:
			out[name] = publisher.NewVK(name, t.Token, t.GroupID, httpc)
		case config.PlatformFacebook:
			out[name] = publisher.NewFacebook(name, t.PageID, t.Token, httpc)
		default:
			return nil, errors.New("unknown platform for target " + name)
		}
	}
	return out, nil
}

// Run executes one campaign by name.
func (r *Runner) Run(ctx context.Context, name string) (Report, error) {
	var cp *config.Campaign
	for i := range r.cfg.Campaigns {
		if r.cfg.Campaigns[i].Name == name {
			cp = &r.cfg.Campaigns[i]
			break
		}
	}
	if cp == nil {
		return Report{}, errors.New("unknown campaign: " + name)
	}
	return r.run(ctx, *cp)
}

func (r *Runner) run(ctx context.Context, cp config.Campaign) (Report, error) {
	rep := Report{Campaign: cp.Name}
	log := r.log.With("campaign", cp.Name)

	cand, err := r.sel.Select(ctx, cp)
	if err != nil {
		return rep, err
	}
	rep.ContentID = cand.ID

	built, err := r.builder.Build(ctx, cp.Region, cand, cp.Filters.ExcerptMs, r.needAudio(cp))
	if err != nil {
		return rep, err
	}

	for _, tn := range cp.Targets {
		rep.Targets = append(rep.Targets, r.publishOne(ctx, cp, tn, cand, built, log))
	}
	return rep, nil
}

func (r *Runner) publishOne(ctx context.Context, cp config.Campaign, tn string, cand catalog.Candidate, built content.Content, log *slog.Logger) TargetResult {
	tr := TargetResult{Target: tn}
	tcfg := r.cfg.Targets[tn]
	pub := r.pubs[tn]
	if tcfg == nil || pub == nil {
		tr.Error = "target not configured"
		return tr
	}

	// Hard idempotency: never post the same content to the same target twice.
	if done, err := r.st.AlreadyPosted(ctx, cand.ID, tn); err != nil {
		tr.Error = err.Error()
		return tr
	} else if done {
		tr.Skipped, tr.Reason = true, "already posted"
		return tr
	}

	post := publisher.Post{
		ContentID: cand.ID,
		Kind:      cand.Kind,
		Lang:      cand.Language,
		Text:      built.Text,
		Title:     built.Title,
		Artist:    built.Artist,
	}

	switch tcfg.Platform {
	case config.PlatformTelegram:
		post.AudioURL = built.AudioURL
	case config.PlatformVK, config.PlatformFacebook:
		img, err := r.resolvePoster(tcfg.Poster)
		if err != nil {
			tr.Error = err.Error()
			return tr
		}
		post.ImageURL = img
		if tcfg.Platform == config.PlatformVK && tcfg.AttachAudio {
			ref, ok := r.st.VKAudioRef(ctx, cand.ID)
			if !ok {
				// attach_audio is a hard requirement for this target: never
				// post a wisdom card to VK without its audio. Missing mapping
				// = fail loudly so the reconcile gap is visible, not silent.
				tr.Error = "vk attach_audio: no audio mapping for " + cand.ID + " (run vk-reconcile)"
				return tr
			}
			post.AudioRef = ref
		}
	}

	res, err := pub.Publish(ctx, post)
	if err != nil {
		log.Error("publish_failed", "target", tn, "content_id", cand.ID, "err", err.Error())
		tr.Error = err.Error()
		return tr
	}
	if err := r.st.Record(ctx, cp.Name, cand.ID, tn, res.Ref); err != nil {
		log.Error("state_record_failed", "target", tn, "err", err.Error())
	}
	log.Info("published", "target", tn, "content_id", cand.ID, "ref", res.Ref)
	tr.Ref = res.Ref
	return tr
}

func (r *Runner) resolvePoster(p config.Poster) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return poster.Resolve(p, r.rng)
}

// needAudio reports whether any target in the campaign consumes audio
// (Telegram) — if not, we skip the share-audio cut entirely.
func (r *Runner) needAudio(cp config.Campaign) bool {
	for _, tn := range cp.Targets {
		if t := r.cfg.Targets[tn]; t != nil && t.Platform == config.PlatformTelegram {
			return true
		}
	}
	return false
}
