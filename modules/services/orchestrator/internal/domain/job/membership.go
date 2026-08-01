package job

// Membership is the authoritative per-track projection the orchestrator accrues
// across operations (persisted in orchestrator.track_memberships). Every op that
// changes the track (ingest, translate) reads-modifies-writes it under a row
// lock: Version is the LWW high-water (the highest run generation applied, so a
// later op out-ranks the prior state), Doc the current library_items payload
// (including the accumulated variants) a new op merges into.
type Membership struct {
	ID      string
	OwnerID string
	Version int
	Doc     []byte
}
