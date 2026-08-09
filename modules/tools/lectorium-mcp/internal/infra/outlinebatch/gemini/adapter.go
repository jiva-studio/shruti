// Package geminioutlinebatch adapts the Gemini batch client to the outline use
// case's Batcher port. The client itself is shared with the review path — the
// batch protocol has nothing to do with what is being generated.
package geminioutlinebatch

import (
	"context"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/outline"
	"github.com/jiva-studio/lectorium/pipeline/review/gemini"
)

// minThinkingBudget is the floor gemini-flash accepts — it cannot be told to
// stop thinking, only to think less, and unbounded it eats the whole output
// budget. flash-lite ignores this and spends nothing either way.
const minThinkingBudget = 128

type Adapter struct {
	Client *gemini.Client
}

type Config struct {
	Endpoint string
	APIKey   string
	Model    string
}

func New(cfg Config) (*Adapter, error) {
	c, err := gemini.New(gemini.Options{
		Endpoint: cfg.Endpoint,
		APIKey:   cfg.APIKey,
		Model:    cfg.Model,
	})
	if err != nil {
		return nil, err
	}
	return &Adapter{Client: c}, nil
}

func (a *Adapter) Submit(ctx context.Context, displayName string, reqs []outline.BatchRequest) (string, error) {
	out := make([]gemini.Request, 0, len(reqs))
	for _, r := range reqs {
		out = append(out, gemini.Request{
			Key: r.Key, System: r.System, User: r.User,
			Temperature: r.Temperature, MaxTokens: r.MaxTokens,
			ThinkingBudget: minThinkingBudget,
		})
	}
	return a.Client.Submit(ctx, displayName, out)
}

func (a *Adapter) Fetch(ctx context.Context, name string) (outline.BatchJob, []outline.BatchResult, error) {
	job, res, err := a.Client.Fetch(ctx, name)
	if err != nil {
		return outline.BatchJob{}, nil, err
	}
	out := make([]outline.BatchResult, 0, len(res))
	for _, r := range res {
		out = append(out, outline.BatchResult{
			Key: r.Key, Text: r.Text, Err: r.Err,
			TokensIn: r.TokensIn, TokensOut: r.TokensOut,
		})
	}
	return outline.BatchJob{
		Name: job.Name, State: string(job.State), Total: job.Stats.Total,
		Successful: job.Stats.Successful, Failed: job.Stats.Failed,
	}, out, nil
}

var _ outline.Batcher = (*Adapter)(nil)
