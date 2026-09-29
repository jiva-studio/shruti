package catalog

// TranscriptAsset is a published transcript as asset_hashes advertises it:
// its public path, the variant it belongs to, and the content hash the chat
// indexer diffs against. SHA256 is empty until the file has been hashed.
type TranscriptAsset struct {
	Path     string
	TrackID  string
	Language string
	SHA256   string
}
