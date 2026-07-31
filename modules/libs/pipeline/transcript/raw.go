package transcript

// RawSegment is one provider segment after our normalization (sort, dedupe,
// overlap trim, linear Idx assignment). Unit of chunking for review.
// Confidence is the average word-confidence reported by the provider over
// the words that landed in this segment, in [0,1]. Carried forward so
// downstream stages can reason about quality without re-running ASR.
type RawSegment struct {
	Idx        int     `json:"idx"`
	Start      int64   `json:"start"` // ms
	End        int64   `json:"end"`   // ms
	Text       string  `json:"text"`
	Confidence float64 `json:"confidence"`
	// Language is this segment's language code as the provider reports it — the
	// same value that keys transcripts/<lang>.json (Deepgram multi returns
	// 2-letter codes, e.g. "en"/"ru"). Empty when the provider doesn't tag per
	// segment. Drives the ingest per-language split; ignored elsewhere.
	Language string `json:"language,omitempty"`
}

// Raw is the language-tagged ASR output for one (track, language).
// Persisted under out/artifacts/tracks/{id}/transcripts/{lang}/raw.json.
// Provider/Model record which engine produced the segments — useful when
// the same lake gets re-transcribed by different models over time.
type Raw struct {
	TrackId  string       `json:"trackId"`
	Language string       `json:"language"`
	Provider string       `json:"provider,omitempty"`
	Model    string       `json:"model,omitempty"`
	Segments []RawSegment `json:"segments"`
}
