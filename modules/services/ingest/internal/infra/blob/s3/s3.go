// Package s3 implements ports.BlobStore against S3 (or any S3-compatible store)
// using aws-sdk-go-v2, mirroring services/share-audio's storage adapter. The
// ingest pipeline writes content-addressed artifacts under
// public/tracks/<track_id>/{audio,transcript} and HEAD-verifies a key before
// the track is announced.
package s3

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	awss3 "github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"
)

// Store is the S3-backed BlobStore.
type Store struct {
	api    *awss3.Client
	bucket string
}

// New builds a Store. endpoint is optional (S3-compatible stores); when empty
// the SDK's default AWS endpoint resolution is used.
func New(ctx context.Context, bucket, region, endpoint string) (*Store, error) {
	if bucket == "" {
		return nil, fmt.Errorf("s3: bucket is required")
	}
	cfg, err := config.LoadDefaultConfig(ctx,
		config.WithRegion(region),
		config.WithRetryMaxAttempts(3),
		config.WithRetryMode(aws.RetryModeStandard),
	)
	if err != nil {
		return nil, fmt.Errorf("aws config: %w", err)
	}
	api := awss3.NewFromConfig(cfg, func(o *awss3.Options) {
		if endpoint != "" {
			o.BaseEndpoint = aws.String(endpoint)
			o.UsePathStyle = true
		}
	})
	return &Store{api: api, bucket: bucket}, nil
}

// Put writes body at key with the given content type.
func (s *Store) Put(ctx context.Context, key string, body []byte, contentType string) error {
	in := &awss3.PutObjectInput{
		Bucket:      aws.String(s.bucket),
		Key:         aws.String(key),
		Body:        bytes.NewReader(body),
		ContentType: aws.String(contentType),
	}
	if _, err := s.api.PutObject(ctx, in); err != nil {
		return fmt.Errorf("put %s: %w", key, err)
	}
	return nil
}

// Get reads the object at key (used by the translate op to load an already-
// stored transcript).
func (s *Store) Get(ctx context.Context, key string) ([]byte, error) {
	out, err := s.api.GetObject(ctx, &awss3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return nil, fmt.Errorf("get %s: %w", key, err)
	}
	defer out.Body.Close()
	return io.ReadAll(out.Body)
}

// Exists HEAD-verifies a key. A genuine 404 is (false, nil); other errors
// propagate so a transient outage isn't misread as absence.
func (s *Store) Exists(ctx context.Context, key string) (bool, error) {
	_, err := s.api.HeadObject(ctx, &awss3.HeadObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	if err == nil {
		return true, nil
	}
	var apiErr smithy.APIError
	if errors.As(err, &apiErr) {
		switch apiErr.ErrorCode() {
		case "NotFound", "NoSuchKey":
			return false, nil
		}
	}
	return false, err
}
