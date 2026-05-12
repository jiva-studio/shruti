// Package chain composes resolvers so cheaper ones (exact match, cache) run
// first; if they don't find a confident match the expensive LLM resolver is
// called.
package chain

import (
	"context"

	catalogport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/catalog"
)

// Chain runs resolvers in order. The first one that returns confidence
// "exact" or "high" wins; otherwise the chain proceeds to the next.
type Chain struct {
	Resolvers []catalogport.Resolver
}

func New(resolvers ...catalogport.Resolver) *Chain { return &Chain{Resolvers: resolvers} }

func (c *Chain) Name() string {
	if len(c.Resolvers) == 0 {
		return "chain[]"
	}
	out := "chain["
	for i, r := range c.Resolvers {
		if i > 0 {
			out += "→"
		}
		out += r.Name()
	}
	return out + "]"
}

func (c *Chain) Resolve(ctx context.Context, req catalogport.ResolveRequest) (catalogport.ResolveResponse, error) {
	var last catalogport.ResolveResponse
	for _, r := range c.Resolvers {
		resp, err := r.Resolve(ctx, req)
		if err != nil {
			// fall through to the next resolver but remember the error if all fail.
			last = catalogport.ResolveResponse{
				Confidence: catalogport.ConfNone,
				Reasoning:  err.Error(),
				Provider:   r.Name(),
			}
			continue
		}
		last = resp
		if resp.Confidence == catalogport.ConfExact || resp.Confidence == catalogport.ConfHigh {
			return resp, nil
		}
	}
	return last, nil
}

var _ catalogport.Resolver = (*Chain)(nil)
