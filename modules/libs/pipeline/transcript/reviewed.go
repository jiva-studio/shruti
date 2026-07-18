package transcript

import "encoding/json"

// Reviewed mirrors the TS Transcript value object on the wire:
//   { "trackId", "language", "version", "blocks": [Block, ...] }
type Reviewed struct {
	TrackId  string
	Language string
	Version  int
	Blocks   []Block
}

func (r Reviewed) MarshalJSON() ([]byte, error) {
	blocks, err := MarshalBlocks(r.Blocks)
	if err != nil {
		return nil, err
	}
	return json.Marshal(struct {
		TrackId  string          `json:"trackId"`
		Language string          `json:"language"`
		Version  int             `json:"version"`
		Blocks   json.RawMessage `json:"blocks"`
	}{r.TrackId, r.Language, r.Version, blocks})
}

func (r *Reviewed) UnmarshalJSON(data []byte) error {
	var raw struct {
		TrackId  string          `json:"trackId"`
		Language string          `json:"language"`
		Version  int             `json:"version"`
		Blocks   json.RawMessage `json:"blocks"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	blocks, err := UnmarshalBlocks(raw.Blocks)
	if err != nil {
		return err
	}
	r.TrackId = raw.TrackId
	r.Language = raw.Language
	r.Version = raw.Version
	r.Blocks = blocks
	return nil
}
