// Package awss3 wraps aws-sdk-go-v2 to implement ports/s3.Uploader for both
// AWS S3 and S3-compatible endpoints (Yandex Object Storage).
package awss3

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"

	s3port "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/s3"
)

type Target struct {
	Name            string // "aws" | "yandex"
	Bucket          string
	Region          string
	Endpoint        string
	AccessKeyID     string
	SecretAccessKey string
	ForcePathStyle  bool
}

type Uploader struct {
	target Target
	client *s3.Client
}

func New(ctx context.Context, t Target) (*Uploader, error) {
	if t.Bucket == "" {
		return nil, fmt.Errorf("%s: bucket required", t.Name)
	}
	if t.Region == "" {
		t.Region = "us-east-1"
	}
	loadOpts := []func(*awsconfig.LoadOptions) error{awsconfig.WithRegion(t.Region)}
	if t.AccessKeyID != "" && t.SecretAccessKey != "" {
		loadOpts = append(loadOpts, awsconfig.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(t.AccessKeyID, t.SecretAccessKey, ""),
		))
	}
	cfg, err := awsconfig.LoadDefaultConfig(ctx, loadOpts...)
	if err != nil {
		return nil, fmt.Errorf("aws config: %w", err)
	}
	clientOpts := []func(*s3.Options){}
	if t.Endpoint != "" {
		clientOpts = append(clientOpts, func(o *s3.Options) {
			o.BaseEndpoint = aws.String(t.Endpoint)
		})
	}
	if t.ForcePathStyle {
		clientOpts = append(clientOpts, func(o *s3.Options) {
			o.UsePathStyle = true
		})
	}
	c := s3.NewFromConfig(cfg, clientOpts...)
	return &Uploader{target: t, client: c}, nil
}

func (u *Uploader) Name() string   { return u.target.Name }
func (u *Uploader) Bucket() string { return u.target.Bucket }

func (u *Uploader) Put(ctx context.Context, key, contentType string, body io.Reader, size int64) error {
	_, err := u.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:        aws.String(u.target.Bucket),
		Key:           aws.String(key),
		Body:          body,
		ContentType:   aws.String(contentType),
		ContentLength: aws.Int64(size),
	})
	return err
}

func (u *Uploader) Head(ctx context.Context, key string) (int64, string, bool, error) {
	resp, err := u.client.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(u.target.Bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		var nf *types.NotFound
		if errors.As(err, &nf) {
			return 0, "", false, nil
		}
		var apiErr smithy.APIError
		if errors.As(err, &apiErr) {
			code := apiErr.ErrorCode()
			if code == "NotFound" || code == "NoSuchKey" {
				return 0, "", false, nil
			}
		}
		return 0, "", false, err
	}
	etag := ""
	if resp.ETag != nil {
		// S3 wraps the ETag in literal double quotes — strip them so the
		// caller can compare against a hex MD5 directly.
		etag = strings.Trim(*resp.ETag, `"`)
	}
	if resp.ContentLength == nil {
		return 0, etag, true, nil
	}
	return *resp.ContentLength, etag, true, nil
}

func (u *Uploader) GetJSON(ctx context.Context, key string, out any) (bool, error) {
	resp, err := u.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(u.target.Bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		var nsk *types.NoSuchKey
		if errors.As(err, &nsk) {
			return false, nil
		}
		var apiErr smithy.APIError
		if errors.As(err, &apiErr) && apiErr.ErrorCode() == "NoSuchKey" {
			return false, nil
		}
		return false, err
	}
	defer resp.Body.Close()
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return false, err
	}
	return true, nil
}

var _ s3port.Uploader = (*Uploader)(nil)
