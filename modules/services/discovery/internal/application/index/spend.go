package index

import (
	"context"
	"log/slog"

	"github.com/jiva-studio/shruti/discovery/internal/domain"
)

// recordSpend keeps what the model calls for this page cost.
//
// A failure to write it is not a failure to index: the recording is stored and
// the bill arrives regardless, so this complains and carries on.
func (s *Service) recordSpend(ctx context.Context, sourceID string) {
	if s.Normalizer == nil {
		return
	}
	for _, sp := range s.Normalizer.Spent() {
		kind := sp.Kind
		if kind == "" {
			kind = "normalize"
		}
		row := domain.Charge{SourceID: sourceID, Kind: kind, Model: sp.Model, Items: sp.Items}
		if sp.Reported {
			in, out, cost := sp.TokensIn, sp.TokensOut, sp.CostUSD
			row.TokensIn, row.TokensOut, row.CostUSD = &in, &out, &cost
		}
		s.Metrics.Spend(sp.CostUSD)
		if err := s.Store.RecordSpend(ctx, row); err != nil {
			slog.WarnContext(ctx, "spend_not_recorded", "source", sourceID, "err", err.Error())
		}
	}
}
