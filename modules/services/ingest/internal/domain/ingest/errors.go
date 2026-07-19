package ingest

import "errors"

// ErrPermanent marks a pipeline failure that re-running cannot fix — a deleted /
// private / age-restricted source, an unsupported or malformed URL, a 4xx, or a
// source that exceeds the size/duration limits. Adapters wrap such failures with
// it (via fmt.Errorf("...: %w", ...)); the worker classifies with errors.Is so a
// permanent failure is reported non-retriable and the orchestrator dead-letters
// instead of burning its whole retry budget on a source that is gone for good.
var ErrPermanent = errors.New("permanent source failure")
