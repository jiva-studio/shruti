// Package storage builds the S3 client + presigner used by the worker
// pipeline. The aws-sdk-go-v2 clients are exposed directly so the
// transcript and backgrounds packages can issue typed commands; we
// don't try to abstract them behind an interface (the SDK is already
// the abstraction).
package storage

import (
	"context"
	"fmt"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type Client struct {
	API        *s3.Client
	Presigner  *s3.PresignClient
	Bucket     string
	Region     string
	PublicBase string
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
	return &Client{
		API:        api,
		Presigner:  s3.NewPresignClient(api),
		Bucket:     bucket,
		Region:     region,
		PublicBase: publicBase,
	}, nil
}

// BuildOutputURL returns the public URL for a finished render. Honours
// OUTPUT_PUBLIC_BASE (CDN/proxy) when set, otherwise composes the
// virtual-hosted form.
func (c *Client) BuildOutputURL(key string) string {
	if c.PublicBase != "" {
		return strings.TrimRight(c.PublicBase, "/") + "/" + key
	}
	return fmt.Sprintf("https://%s.s3.%s.amazonaws.com/%s", c.Bucket, c.Region, key)
}
