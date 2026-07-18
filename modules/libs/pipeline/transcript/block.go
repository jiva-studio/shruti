package transcript

import (
	"encoding/json"
	"fmt"
)

// Block is the sealed sum type for transcript blocks. Wire shape mirrors
// source/shruti/modules/libs/domain/transcript.ts exactly:
//
//   { "type": "paragraph",        "start": ms, "end": ms }
//   { "type": "sentence",         "start": ms, "end": ms, "text": str, "speaker"?: str, "reference"?: Reference }
//   { "type": "verse:text",       "start": ms, "end": ms, "text": [str, ...], "reference"?: Reference }
//   { "type": "verse:translation","start": ms, "end": ms, "text": str }
//
// All start/end are integer milliseconds.
type Block interface {
	isBlock()
	Type() string
	StartMs() int64
	EndMs() int64
}

type Reference struct {
	SourceID string   `json:"sourceId"`
	Tokens   []string `json:"tokens"`
}

type ParagraphBlock struct {
	Start int64 `json:"start"`
	End   int64 `json:"end"`
}

func (ParagraphBlock) isBlock()        {}
func (ParagraphBlock) Type() string    { return "paragraph" }
func (b ParagraphBlock) StartMs() int64 { return b.Start }
func (b ParagraphBlock) EndMs() int64   { return b.End }

type SentenceBlock struct {
	Start     int64      `json:"start"`
	End       int64      `json:"end"`
	Text      string     `json:"text"`
	Speaker   string     `json:"speaker,omitempty"`
	Reference *Reference `json:"reference,omitempty"`
}

func (SentenceBlock) isBlock()        {}
func (SentenceBlock) Type() string    { return "sentence" }
func (b SentenceBlock) StartMs() int64 { return b.Start }
func (b SentenceBlock) EndMs() int64   { return b.End }

type VerseTextBlock struct {
	Start     int64      `json:"start"`
	End       int64      `json:"end"`
	Text      []string   `json:"text"`
	Reference *Reference `json:"reference,omitempty"`
}

func (VerseTextBlock) isBlock()        {}
func (VerseTextBlock) Type() string    { return "verse:text" }
func (b VerseTextBlock) StartMs() int64 { return b.Start }
func (b VerseTextBlock) EndMs() int64   { return b.End }

type VerseTranslationBlock struct {
	Start int64  `json:"start"`
	End   int64  `json:"end"`
	Text  string `json:"text"`
}

func (VerseTranslationBlock) isBlock()        {}
func (VerseTranslationBlock) Type() string    { return "verse:translation" }
func (b VerseTranslationBlock) StartMs() int64 { return b.Start }
func (b VerseTranslationBlock) EndMs() int64   { return b.End }

// MarshalBlock writes a single block with its discriminator.
func MarshalBlock(b Block) ([]byte, error) {
	switch v := b.(type) {
	case ParagraphBlock:
		return json.Marshal(struct {
			Type string `json:"type"`
			ParagraphBlock
		}{v.Type(), v})
	case SentenceBlock:
		return json.Marshal(struct {
			Type string `json:"type"`
			SentenceBlock
		}{v.Type(), v})
	case VerseTextBlock:
		return json.Marshal(struct {
			Type string `json:"type"`
			VerseTextBlock
		}{v.Type(), v})
	case VerseTranslationBlock:
		return json.Marshal(struct {
			Type string `json:"type"`
			VerseTranslationBlock
		}{v.Type(), v})
	default:
		return nil, fmt.Errorf("unknown block type %T", b)
	}
}

// UnmarshalBlock parses one block, dispatching on the "type" field.
func UnmarshalBlock(raw json.RawMessage) (Block, error) {
	var head struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &head); err != nil {
		return nil, fmt.Errorf("transcript block: missing type: %w", err)
	}
	switch head.Type {
	case "paragraph":
		var b ParagraphBlock
		if err := json.Unmarshal(raw, &b); err != nil {
			return nil, err
		}
		return b, nil
	case "sentence":
		var b SentenceBlock
		if err := json.Unmarshal(raw, &b); err != nil {
			return nil, err
		}
		return b, nil
	case "verse:text":
		var b VerseTextBlock
		if err := json.Unmarshal(raw, &b); err != nil {
			return nil, err
		}
		return b, nil
	case "verse:translation":
		var b VerseTranslationBlock
		if err := json.Unmarshal(raw, &b); err != nil {
			return nil, err
		}
		return b, nil
	default:
		return nil, fmt.Errorf("transcript block: unknown type %q", head.Type)
	}
}

// MarshalBlocks serializes a slice of blocks as a JSON array.
func MarshalBlocks(blocks []Block) ([]byte, error) {
	out := make([]json.RawMessage, len(blocks))
	for i, b := range blocks {
		raw, err := MarshalBlock(b)
		if err != nil {
			return nil, fmt.Errorf("block[%d]: %w", i, err)
		}
		out[i] = raw
	}
	return json.Marshal(out)
}

// UnmarshalBlocks parses a JSON array of blocks.
func UnmarshalBlocks(raw json.RawMessage) ([]Block, error) {
	var rawList []json.RawMessage
	if err := json.Unmarshal(raw, &rawList); err != nil {
		return nil, err
	}
	out := make([]Block, len(rawList))
	for i, item := range rawList {
		b, err := UnmarshalBlock(item)
		if err != nil {
			return nil, fmt.Errorf("block[%d]: %w", i, err)
		}
		out[i] = b
	}
	return out, nil
}
