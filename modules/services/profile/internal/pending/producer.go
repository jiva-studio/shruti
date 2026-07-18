package pending

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jiva-studio/shruti/profile/internal/config"
)

// uploader is the minimal S3 surface the producer needs. Abstracted so a test
// could stand in a fake, and so the concrete aws-sdk client stays isolated.
type uploader interface {
	put(ctx context.Context, key, contentType string, body []byte) error
}

// Producer periodically exports the ready library_items into a pending.db and
// uploads it to S3. Disabled (nil) when S3 config is absent.
type Producer struct {
	pool     *pgxpool.Pool
	up       uploader
	key      string
	interval time.Duration
}

// NewProducer builds a producer from config. Returns (nil, nil) when the
// producer is disabled (no bucket) so the caller can no-op cleanly.
func NewProducer(ctx context.Context, pool *pgxpool.Pool, cfg config.PendingConfig) (*Producer, error) {
	if !cfg.Enabled() {
		return nil, nil
	}
	up, err := newS3Uploader(ctx, cfg)
	if err != nil {
		return nil, err
	}
	interval := cfg.Interval
	if interval <= 0 {
		interval = 5 * time.Minute
	}
	return &Producer{pool: pool, up: up, key: cfg.Key, interval: interval}, nil
}

// Run builds the artifact once and uploads it.
func (p *Producer) Run(ctx context.Context) error {
	rows, err := QueryRows(ctx, p.pool)
	if err != nil {
		return err
	}

	dir, err := os.MkdirTemp("", "pending-db-")
	if err != nil {
		return fmt.Errorf("tempdir: %w", err)
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "pending.db")

	if err := WriteDB(path, rows); err != nil {
		return err
	}
	blob, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read built db: %w", err)
	}
	if err := p.up.put(ctx, p.key, "application/x-sqlite3", blob); err != nil {
		return fmt.Errorf("upload %s: %w", p.key, err)
	}
	slog.InfoContext(ctx, "pending_db_published", "key", p.key, "rows", len(rows), "bytes", len(blob))
	return nil
}

// Start runs Run once immediately, then on every tick until ctx is cancelled.
// Intended to be launched in its own goroutine alongside the HTTP server. An
// iteration failure is logged and the loop continues (transient S3/DB blips
// must not kill the producer).
func (p *Producer) Start(ctx context.Context) {
	if err := p.Run(ctx); err != nil && ctx.Err() == nil {
		slog.ErrorContext(ctx, "pending_db_run_failed", "err", err.Error())
	}
	ticker := time.NewTicker(p.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			slog.Info("pending_producer_stopped")
			return
		case <-ticker.C:
			if err := p.Run(ctx); err != nil && ctx.Err() == nil {
				slog.ErrorContext(ctx, "pending_db_run_failed", "err", err.Error())
			}
		}
	}
}

// s3Uploader is the concrete aws-sdk-go-v2 implementation of uploader,
// mirroring the orchestrator's blob adapter (static creds + optional
// S3-compatible endpoint + path-style addressing).
type s3Uploader struct {
	client *s3.Client
	bucket string
}

func newS3Uploader(ctx context.Context, cfg config.PendingConfig) (*s3Uploader, error) {
	region := cfg.Region
	if region == "" {
		region = "us-east-1"
	}
	loadOpts := []func(*awsconfig.LoadOptions) error{awsconfig.WithRegion(region)}
	if cfg.AccessKeyID != "" && cfg.SecretAccessKey != "" {
		loadOpts = append(loadOpts, awsconfig.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(cfg.AccessKeyID, cfg.SecretAccessKey, ""),
		))
	}
	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, loadOpts...)
	if err != nil {
		return nil, fmt.Errorf("aws config: %w", err)
	}
	client := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		if cfg.Endpoint != "" {
			o.BaseEndpoint = aws.String(cfg.Endpoint)
		}
		if cfg.ForcePathStyle {
			o.UsePathStyle = true
		}
	})
	return &s3Uploader{client: client, bucket: cfg.Bucket}, nil
}

func (u *s3Uploader) put(ctx context.Context, key, contentType string, body []byte) error {
	_, err := u.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:        aws.String(u.bucket),
		Key:           aws.String(key),
		Body:          bytes.NewReader(body),
		ContentType:   aws.String(contentType),
		ContentLength: aws.Int64(int64(len(body))),
	})
	return err
}
