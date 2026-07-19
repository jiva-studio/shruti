// Package s3 implements an S3 (or S3-compatible) blob adapter using
// aws-sdk-go-v2, mirroring services/orchestrator's storage adapter. The
// publish-service uses it to upload the rebuilt pending.db review artifact and
// (optionally) to fetch the published corpus catalog current.db.
package s3

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	awss3 "github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"
)

// Options configures the Store.
type Options struct {
	Bucket         string
	Region         string
	Endpoint       string // optional; for S3-compatible stores
	AccessKeyID    string // optional static creds
	SecretKey      string
	ForcePathStyle bool
}

// Store is the S3-backed blob adapter.
type Store struct {
	api    *awss3.Client
	bucket string
}

// New builds a Store. endpoint is optional (S3-compatible stores); when empty
// the SDK's default AWS endpoint resolution is used. Static credentials are used
// when both AccessKeyID and SecretKey are set, else the SDK's default chain.
func New(ctx context.Context, o Options) (*Store, error) {
	if o.Bucket == "" {
		return nil, fmt.Errorf("s3: bucket is required")
	}
	region := o.Region
	if region == "" {
		region = "us-east-1"
	}
	loadOpts := []func(*config.LoadOptions) error{
		config.WithRegion(region),
		config.WithRetryMaxAttempts(3),
		config.WithRetryMode(aws.RetryModeStandard),
	}
	if o.AccessKeyID != "" && o.SecretKey != "" {
		loadOpts = append(loadOpts, config.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(o.AccessKeyID, o.SecretKey, ""),
		))
	}
	cfg, err := config.LoadDefaultConfig(ctx, loadOpts...)
	if err != nil {
		return nil, fmt.Errorf("aws config: %w", err)
	}
	api := awss3.NewFromConfig(cfg, func(op *awss3.Options) {
		if o.Endpoint != "" {
			op.BaseEndpoint = aws.String(o.Endpoint)
		}
		if o.ForcePathStyle {
			op.UsePathStyle = true
		}
	})
	return &Store{api: api, bucket: o.Bucket}, nil
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

// Get reads the whole object at key. A genuine 404 surfaces as ErrNotFound.
func (s *Store) Get(ctx context.Context, key string) ([]byte, error) {
	out, err := s.api.GetObject(ctx, &awss3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		var apiErr smithy.APIError
		if errors.As(err, &apiErr) {
			switch apiErr.ErrorCode() {
			case "NotFound", "NoSuchKey":
				return nil, ErrNotFound
			}
		}
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

// ErrNotFound is returned by Get when the key does not exist.
var ErrNotFound = errors.New("s3: object not found")
