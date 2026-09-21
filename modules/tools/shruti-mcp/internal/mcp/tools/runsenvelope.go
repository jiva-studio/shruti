package tools

// runDispatch is the canonical async-dispatch summary embedded in the
// envelope's `run` field. Aligned with the per-tool shape the v2 plan
// §A specifies — minimal up-front, full state retrievable via runs.status.
type runDispatch struct {
	ID            string `json:"id"`
	Kind          string `json:"kind"`
	State         string `json:"state"`
	AcceptedCount int    `json:"accepted_count"`
	RejectedCount int    `json:"rejected_count,omitempty"`
	Rejected      []any  `json:"rejected,omitempty"`
}
