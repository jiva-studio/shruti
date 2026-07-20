// Package mirror is the storage-mirror domain: the vocabulary and the rules for
// keeping the Russia mirror (Yandex Object Storage) faithful to the source of
// truth (Bunny Edge Storage).
//
// The domain owns exactly one decision — whether a source object must be
// re-shipped to the mirror — plus the lifecycle event that lets a freshly
// ingested track reach the mirror immediately instead of waiting for the next
// full pass. Everything about HTTP, S3 and Redis lives in infra behind ports,
// so the mirroring policy is testable without touching either provider.
package mirror

// Object is one object on the source (Bunny): its key, byte size and content
// SHA-256. Bunny exposes the checksum in its directory listing, so change
// detection never has to re-download the body.
type Object struct {
	Key    string
	Size   int64
	SHA256 string
}

// MirrorState is what the mirror currently holds for a key.
//
// SHA256 is the `bunny-sha256` stamp written on a previous pass. It is EMPTY
// for a legacy object shipped by the retired S3→Yandex rclone workflow, which
// is exactly why Size is kept as a fallback signal — see NeedsTransfer.
type MirrorState struct {
	Exists bool
	Size   int64
	SHA256 string
}

// NeedsTransfer is the single mirroring rule:
//
//   - absent from the mirror          → ship it
//   - stamped by a previous pass      → ship only when the checksum differs
//   - legacy, unstamped (rclone era)  → fall back to comparing size, so the
//     first pass after the cutover does not re-ship the entire corpus
//
// Pure and total — no I/O, no clock, no error path.
func NeedsTransfer(src Object, dst MirrorState) bool {
	if !dst.Exists {
		return true
	}
	if dst.SHA256 != "" {
		return dst.SHA256 != src.SHA256
	}
	return dst.Size != src.Size
}
