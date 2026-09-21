package transcript

import "encoding/json"

// Reviewed mirrors the TS Transcript value object on the wire:
//
//	{ "trackId", "language", "version", "blocks": [Block, ...] }
type Reviewed struct {
	TrackID  string
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
		TrackID  string          `json:"trackId"`
		Language string          `json:"language"`
		Version  int             `json:"version"`
		Blocks   json.RawMessage `json:"blocks"`
	}{r.TrackID, r.Language, r.Version, blocks})
}

func (r *Reviewed) UnmarshalJSON(data []byte) error {
	var raw struct {
		TrackID  string          `json:"trackId"`
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
	r.TrackID = raw.TrackID
	r.Language = raw.Language
	r.Version = raw.Version
	r.Blocks = blocks
	return nil
}
