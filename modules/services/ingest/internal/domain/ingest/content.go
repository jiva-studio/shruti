package ingest

import (
	"crypto/sha256"
	"encoding/hex"
)

// ContentID derives a track's stable, content-addressed id from the bytes of
// its canonical audio artifact: the lowercase-hex SHA-256 digest. The same
// audio always yields the same track_id, so re-ingesting a source is idempotent
// and dedup collapses to a primary-key check. This value is the `track_id` used
// throughout the pipeline and the public/tracks/<track_id>/… blob path.
func ContentID(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
