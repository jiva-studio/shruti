// Package exact is a deterministic catalog resolver that only finds matches by
// case-insensitive equality on full_name (and short_name for sources). Used
// as the pre-pass in metadata_extract before falling back to the LLM resolver.
package exact

import (
	"context"
	"strings"

	"github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
	catalogport "github.com/akdasa-studios/shruti/modules/tools/shruti-mcp/internal/ports/catalog"
)

// Resolver runs string equality against the candidate set the request
// already carries. It needs no state — Resolve walks req.Candidates only.
type Resolver struct{}

func New() *Resolver { return &Resolver{} }

func (r *Resolver) Name() string { return "exact" }

func (r *Resolver) Resolve(ctx context.Context, req catalogport.ResolveRequest) (catalogport.ResolveResponse, error) {
	if req.Query == "" {
		return catalogport.ResolveResponse{Confidence: catalogport.ConfNone, Provider: r.Name()}, nil
	}
	q := normalize(req.Query)
	for _, c := range req.Candidates {
		for _, name := range c.Names {
			if normalize(name) == q {
				return catalogport.ResolveResponse{
					MatchedID:  c.Id,
					Confidence: catalogport.ConfExact,
					Reasoning:  "exact name match",
					Provider:   r.Name(),
				}, nil
			}
		}
		if req.Kind == catalog.KindSource {
			for _, sn := range c.ShortName {
				if strings.EqualFold(sn, req.Query) {
					return catalogport.ResolveResponse{
						MatchedID:  c.Id,
						Confidence: catalogport.ConfExact,
						Reasoning:  "exact short_name match",
						Provider:   r.Name(),
					}, nil
				}
			}
		}
	}
	return catalogport.ResolveResponse{Confidence: catalogport.ConfNone, Provider: r.Name()}, nil
}

func normalize(s string) string {
	return strings.ToLower(strings.Join(strings.Fields(s), " "))
}
