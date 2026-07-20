// Package yandex is the MirrorStore adapter over Yandex Object Storage, which
// IS S3-compatible and therefore speaks aws-sdk-go-v2.
//
// Every object this adapter writes carries the source's SHA-256 as the
// `bunny-sha256` user metadata stamp. That stamp is the whole basis of cheap
// change detection: the next pass compares it against Bunny's listed checksum
// instead of re-downloading the body. Objects WITHOUT the stamp are legacy —
// shipped by the retired S3→Yandex rclone workflow — and the domain falls back
// to a size comparison for them (see mirror.NeedsTransfer).
package yandex

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	awscfg "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	smithy "github.com/aws/smithy-go"

	"github.com/jiva-studio/lectorium-storage-sync/internal/domain/mirror"
)

// metaKey is the user-metadata key holding the source checksum.
const metaKey = "bunny-sha256"

// deleteBatch is S3's per-request cap for DeleteObjects.
const deleteBatch = 1000

// DefaultEndpoint / DefaultRegion target Yandex Object Storage.
const (
	DefaultEndpoint = "https://storage.yandexcloud.net"
	DefaultRegion   = "ru-central1"
)

// Store reads and writes one Yandex bucket.
type Store struct {
	bucket string
	c      *s3.Client
}

// Options configures the adapter.
type Options struct {
	Bucket      string
	Endpoint    string // defaults to DefaultEndpoint
	Region      string // defaults to DefaultRegion
	AccessKeyID string
	SecretKey   string
}

// New builds the adapter.
func New(ctx context.Context, o Options) (*Store, error) {
	if o.Bucket == "" {
		return nil, fmt.Errorf("yandex: bucket is required")
	}
	region := o.Region
	if region == "" {
		region = DefaultRegion
	}
	endpoint := o.Endpoint
	if endpoint == "" {
		endpoint = DefaultEndpoint
	}
	cfg, err := awscfg.LoadDefaultConfig(ctx,
		awscfg.WithRegion(region),
		awscfg.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(o.AccessKeyID, o.SecretKey, "")),
	)
	if err != nil {
		return nil, fmt.Errorf("yandex: aws config: %w", err)
	}
	c := s3.NewFromConfig(cfg, func(so *s3.Options) {
		so.BaseEndpoint = aws.String(endpoint)
	})
	return &Store{bucket: o.Bucket, c: c}, nil
}

// State reports what the mirror holds for a key. A missing object is
// (Exists:false), not an error.
func (s *Store) State(ctx context.Context, key string) (mirror.MirrorState, error) {
	h, err := s.c.HeadObject(ctx, &s3.HeadObjectInput{Bucket: &s.bucket, Key: &key})
	if err != nil {
		if isNotFound(err) {
			return mirror.MirrorState{}, nil
		}
		return mirror.MirrorState{}, err
	}
	stamp := ""
	if h.Metadata != nil {
		stamp = strings.ToLower(h.Metadata[metaKey])
	}
	return mirror.MirrorState{
		Exists: true,
		Size:   aws.ToInt64(h.ContentLength),
		SHA256: stamp,
	}, nil
}

// Put streams a body into the mirror, stamping the source checksum.
//
// The body is spooled to a temp file first: the S3 SDK needs a seekable body
// with a known length to sign and retry the request, and the source is a plain
// streaming HTTP response.
func (s *Store) Put(ctx context.Context, obj mirror.Object, body io.Reader, contentType string) error {
	tmp, err := os.CreateTemp("", "ssync-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()

	n, err := io.Copy(tmp, body)
	if err != nil {
		return err
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return err
	}
	_, err = s.c.PutObject(ctx, &s3.PutObjectInput{
		Bucket:        &s.bucket,
		Key:           &obj.Key,
		Body:          tmp,
		ContentLength: aws.Int64(n),
		ContentType:   strPtrOrNil(contentType),
		Metadata:      map[string]string{metaKey: obj.SHA256},
	})
	return err
}

// ListKeys returns every mirror key under prefix.
func (s *Store) ListKeys(ctx context.Context, prefix string) ([]string, error) {
	var out []string
	p := s3.NewListObjectsV2Paginator(s.c, &s3.ListObjectsV2Input{
		Bucket: &s.bucket,
		Prefix: strPtrOrNil(prefix),
	})
	for p.HasMorePages() {
		page, err := p.NextPage(ctx)
		if err != nil {
			return nil, err
		}
		for _, o := range page.Contents {
			out = append(out, aws.ToString(o.Key))
		}
	}
	return out, nil
}

// DeleteKeys removes keys in S3-sized batches, returning how many were deleted.
func (s *Store) DeleteKeys(ctx context.Context, keys []string) (int, error) {
	deleted := 0
	for i := 0; i < len(keys); i += deleteBatch {
		end := i + deleteBatch
		if end > len(keys) {
			end = len(keys)
		}
		ids := make([]types.ObjectIdentifier, 0, end-i)
		for _, k := range keys[i:end] {
			ids = append(ids, types.ObjectIdentifier{Key: aws.String(k)})
		}
		if _, err := s.c.DeleteObjects(ctx, &s3.DeleteObjectsInput{
			Bucket: &s.bucket,
			Delete: &types.Delete{Objects: ids},
		}); err != nil {
			return deleted, err
		}
		deleted += end - i
	}
	return deleted, nil
}

// isNotFound recognises S3's several ways of saying "no such object".
func isNotFound(err error) bool {
	var ae smithy.APIError
	for e := err; e != nil; {
		if a, ok := e.(smithy.APIError); ok {
			ae = a
			switch ae.ErrorCode() {
			case "NotFound", "NoSuchKey", "404":
				return true
			}
			return false
		}
		u, ok := e.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		e = u.Unwrap()
	}
	return false
}

func strPtrOrNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
