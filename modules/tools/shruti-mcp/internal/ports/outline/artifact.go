// Package outlineport defines the port for reading outline artifacts.
package outlineport

import "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/track"

// GranularRef identifies one granular outline artifact (one track, one
// language). Listed by the topic build to walk every track that has a granular
// outline.
type GranularRef struct {
	TrackID  track.ID
	Language string
}

// GranularEntry is one fine-grained heading from the private granular outline
// artifact (artifacts/tracks/<id>/outline/<lang>/granular.json). The JSON shape
// matches what the outline use case writes ({title,start,end} in ms). It feeds
// the offline topic build/assign.
type GranularEntry struct {
	Title string `json:"title"`
	Start int64  `json:"start"`
	End   int64  `json:"end"`
}
