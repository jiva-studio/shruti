// Package blobpath owns the content-addressed PUBLIC key scheme for a track's
// artifacts — the single source of truth for where audio and transcripts live
// under the CDN bucket. Both the lectorium-mcp pipeline and the ingest worker
// publish to these exact keys; if the two ever drifted the CDN would 404, so
// the scheme is a domain invariant kept in one place.
//
// Keys are bucket-relative (no leading slash). A local filesystem store turns
// a key into a path with filepath.Join(outDir, filepath.FromSlash(key)).
package blobpath

// AudioKey is the public bucket key of a track's audio for a given version
// ("original", "clean", …): public/tracks/{id}/audio/{version}.mp3
func AudioKey(trackID, version string) string {
	return "public/tracks/" + trackID + "/audio/" + version + ".mp3"
}

// TranscriptKey is the public bucket key of a track's reviewed transcript in a
// given language: public/tracks/{id}/transcripts/{lang}.json
func TranscriptKey(trackID, lang string) string {
	return "public/tracks/" + trackID + "/transcripts/" + lang + ".json"
}

// CoverKey is the public bucket key of a track's cover image:
// public/tracks/{id}/cover.jpg
func CoverKey(trackID string) string {
	return "public/tracks/" + trackID + "/cover.jpg"
}
