// Package geminibatch adapts the Gemini batch client to the review use case's
// Batcher port.
package geminibatch

import (
	"context"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/review"
	"github.com/jiva-studio/lectorium/pipeline/review/gemini"
)

type Adapter struct {
	Client *gemini.Client
}

type Config struct {
	Endpoint  string
	APIKey    string
	Model     string
	MaxTokens int
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

func (a *Adapter) Submit(ctx context.Context, displayName string, reqs []review.BatchRequest) (string, error) {
	out := make([]gemini.Request, 0, len(reqs))
	for _, r := range reqs {
		out = append(out, gemini.Request{
			Key: r.Key, System: r.System, User: r.User,
			Temperature: r.Temperature, MaxTokens: r.MaxTokens,
		})
	}
	return a.Client.Submit(ctx, displayName, out)
}

func (a *Adapter) Fetch(ctx context.Context, name string) (review.BatchJob, []review.BatchResult, error) {
	job, res, err := a.Client.Fetch(ctx, name)
	if err != nil {
		return review.BatchJob{}, nil, err
	}
	out := make([]review.BatchResult, 0, len(res))
	for _, r := range res {
		out = append(out, review.BatchResult{
			Key: r.Key, Text: r.Text, Err: r.Err,
			TokensIn: r.TokensIn, TokensOut: r.TokensOut,
		})
	}
	return review.BatchJob{
		Name: job.Name, State: string(job.State), Total: job.Stats.Total,
		Successful: job.Stats.Successful, Failed: job.Stats.Failed,
	}, out, nil
}

var _ review.Batcher = (*Adapter)(nil)
