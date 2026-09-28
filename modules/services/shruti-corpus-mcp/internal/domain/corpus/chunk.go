package corpus

// Chunk is one retrieved piece of the corpus. Pointer fields are nil for chunk
// kinds that do not carry them: item, source, tokens and author are absent on
// transcripts, start/end on library chunks.
type Chunk struct {
	ChunkID   int64   `json:"chunk_id"`
	Kind      string  `json:"kind"`
	Score     float64 `json:"score"`
	Lang      string  `json:"lang"`
	Text      string  `json:"text"`
	ItemID    *string `json:"item_id,omitempty"`
	TrackID   *string `json:"track_id,omitempty"`
	SourceID  *string `json:"source_id,omitempty"`
	Tokens    *string `json:"tokens,omitempty"`
	AuthorID  *string `json:"author_id,omitempty"`
	AddrLabel *string `json:"addr_label,omitempty"`
	StartMs   *int32  `json:"start_ms,omitempty"`
	EndMs     *int32  `json:"end_ms,omitempty"`
}

// LaneTimings is how long each lane of a hybrid retrieval took, in
// milliseconds.
type LaneTimings struct {
	VectorMs  int64
	LexicalMs int64
}

// Deref returns *p, or "" for nil.
func Deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
