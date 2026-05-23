// Package storage wraps the parts of S3 the cut pipeline needs:
// presence probe, download to temp file, upload from temp file, and
// public URL composition that honours an optional CDN base override.
package storage

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"
)

type Client struct {
	api        *s3.Client
	bucket     string
	region     string
	publicBase string
}

func New(ctx context.Context, bucket, region, endpointURL, publicBase string) (*Client, error) {
	cfg, err := config.LoadDefaultConfig(ctx,
		config.WithRegion(region),
		config.WithRetryMaxAttempts(3),
		config.WithRetryMode(aws.RetryModeStandard),
	)
	if err != nil {
		return nil, fmt.Errorf("aws config: %w", err)
	}
	api := s3.NewFromConfig(cfg, func(o *s3.Options) {
		if endpointURL != "" {
			o.BaseEndpoint = aws.String(endpointURL)
		}
	})
	return &Client{api: api, bucket: bucket, region: region, publicBase: publicBase}, nil
}

// Exists reports whether key is present. Non-404 errors propagate so the
// caller can distinguish a genuine S3 outage from a missing object.
func (c *Client) Exists(ctx context.Context, key string) (bool, error) {
	_, err := c.api.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(c.bucket),
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

// DownloadTo streams an object body into dstPath. dstPath is created
// (truncated) by the caller's tempdir contract.
func (c *Client) DownloadTo(ctx context.Context, key, dstPath string) error {
	out, err := c.api.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(c.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		return fmt.Errorf("get %s: %w", key, err)
	}
	defer out.Body.Close()

	f, err := os.Create(dstPath)
	if err != nil {
		return fmt.Errorf("create %s: %w", dstPath, err)
	}
	defer f.Close()
	if _, err := io.Copy(f, out.Body); err != nil {
		return fmt.Errorf("write %s: %w", dstPath, err)
	}
	return nil
}

// Upload reads localPath in one shot and PUTs it. Excerpts are <10 MB so
// streaming via multipart-uploader is unnecessary churn.
func (c *Client) Upload(ctx context.Context, key, localPath, contentType, cacheControl string) error {
	body, err := os.ReadFile(localPath)
	if err != nil {
		return fmt.Errorf("read %s: %w", localPath, err)
	}
	in := &s3.PutObjectInput{
		Bucket:      aws.String(c.bucket),
		Key:         aws.String(key),
		Body:        bytes.NewReader(body),
		ContentType: aws.String(contentType),
	}
	if cacheControl != "" {
		in.CacheControl = aws.String(cacheControl)
	}
	if _, err := c.api.PutObject(ctx, in); err != nil {
		return fmt.Errorf("put %s: %w", key, err)
	}
	return nil
}

// BuildURL composes the public URL: PublicBase if set, otherwise the
// virtual-hosted S3 form. Matches storage.py:build_excerpt_url exactly.
func (c *Client) BuildURL(key string) string {
	if c.publicBase != "" {
		return strings.TrimRight(c.publicBase, "/") + "/" + key
	}
	return fmt.Sprintf("https://%s.s3.%s.amazonaws.com/%s", c.bucket, c.region, key)
}
