package loudness

import "context"

// Report is what we record in the normalize stage payload.
type Report struct {
	Bitrate    int // kbps measured from output
	DurationMs int64
}

type Normalizer interface {
	Normalize(ctx context.Context, in, out string) (Report, error)
}
