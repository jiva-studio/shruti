package domain

// What a chunk is. See migration 0004.
const (
	// ChunkTitle is the recording's own name.
	ChunkTitle = "title"
	// ChunkPageText is prose the archive published about it — a search key,
	// never a transcript.
	ChunkPageText = "page_text"
)

// Chunk is one searchable piece of text and its vector.
type Chunk struct {
	ItemID int64
	// Kind is ChunkTitle or ChunkPageText.
	Kind string
	// Lang is the language of this piece, where the archive stated one.
	Lang      string
	Ordinal   int
	Text      string
	Embedding []float32
}
