package s3port

import (
	"context"
	"io"
)

type Uploader interface {
	Name() string // "aws" | "yandex"
	Bucket() string
	Put(ctx context.Context, key, contentType string, body io.Reader, size int64) error
	GetJSON(ctx context.Context, key string, out any) (found bool, err error)

	// Head probes for an existing object. exists=false with err=nil when the
	// key isn't there. Used by incremental publish to skip files that already
	// match in size; etag is the bare ETag value (quotes stripped) for
	// optional content verification — empty when the backend didn't return one.
	//
	// Caveat: for single-part S3 PUT, ETag is the object's MD5 in hex.
	// For multipart uploads, ETag is "<MD5-of-MD5-chunks>-<n>" — not a plain
	// content hash. Callers that want a strict equality check should treat
	// any etag containing '-' as unverifiable and either re-upload or fall
	// back to size-only.
	Head(ctx context.Context, key string) (size int64, etag string, exists bool, err error)
}
