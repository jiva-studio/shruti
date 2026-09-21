package main

import (
	"context"
	"fmt"
	"os"

	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/collectioncover"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/covergen"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/topiccover"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/config"
	sqlitecatalog "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/catalog/sqlite"
	openrouterimage "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/imagegen/openrouter"
	awss3 "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/s3/aws"
	bunnys3 "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/s3/bunny"
	s3port "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/s3"
)

// AWS is required (read+write); Yandex is a mirror. Built up front so the
// artifact stores share the same uploaders as the publish path. A target that
// fails to init is skipped, not fatal.
func buildPublishTargets(ctx context.Context, cfg config.S3) (targets []s3port.Uploader, bunny s3port.Uploader) {
	if cfg.AWS.Bucket != "" {
		aws, err := awss3.New(ctx, awsTarget("aws", cfg.AWS))
		if err != nil {
			fmt.Fprintf(os.Stderr, "[s3:aws] init failed (catalog_publish will error): %v\n", err)
		} else {
			targets = append(targets, aws)
		}
	}
	if cfg.Yandex.Bucket != "" {
		ya, err := awss3.New(ctx, awsTarget("yandex", cfg.Yandex))
		if err != nil {
			fmt.Fprintf(os.Stderr, "[s3:yandex] init failed: %v\n", err)
		} else {
			targets = append(targets, ya)
		}
	}
	if cfg.Bunny.Zone != "" {
		bny, err := bunnys3.New(bunnys3.Target{
			Name:      "bunny",
			Zone:      cfg.Bunny.Zone,
			Endpoint:  cfg.Bunny.Endpoint,
			AccessKey: cfg.Bunny.AccessKey,
		})
		if err != nil {
			fmt.Fprintf(os.Stderr, "[s3:bunny] init failed: %v\n", err)
		} else {
			targets = append(targets, bny)
			bunny = bny
		}
	}
	return targets, bunny
}

func awsTarget(name string, t config.S3Target) awss3.Target {
	return awss3.Target{
		Name:            name,
		Bucket:          t.Bucket,
		Region:          t.Region,
		Endpoint:        t.Endpoint,
		AccessKeyID:     t.AccessKeyID,
		SecretAccessKey: t.SecretAccessKey,
		ForcePathStyle:  t.ForcePathStyle,
	}
}

// Target for collection and topic covers and author avatars: Bunny, or AWS
// when a bucket is configured.
func buildAssetUploader(ctx context.Context, cfg config.S3, bunny s3port.Uploader) (s3port.Uploader, error) {
	if bunny != nil || cfg.AWS.Bucket == "" {
		return bunny, nil
	}
	up, err := awss3.New(ctx, awsTarget("aws", cfg.AWS))
	if err != nil {
		return nil, fmt.Errorf("asset uploader: %w", err)
	}
	return up, nil
}

// One generic covergen engine, parametrized per entity by a thin Repo adapter
// and an S3 key prefix. Both stay zero-valued when images are not configured.
func buildCoverGenerators(cfg config.Images, uploader s3port.Uploader, currentDBPath string) (collection, topic covergen.UseCase, err error) {
	if cfg.APIKey == "" || uploader == nil {
		return collection, topic, nil
	}
	imgClient, err := openrouterimage.New(openrouterimage.Config{
		Endpoint: cfg.Endpoint,
		APIKey:   cfg.APIKey,
		Model:    cfg.Model,
	})
	if err != nil {
		return collection, topic, fmt.Errorf("image generator: %w", err)
	}
	collection = covergen.UseCase{
		Repo:     collectioncover.Repo{Catalog: sqlitecatalog.NewLazy(currentDBPath)},
		Prefix:   "public/collections",
		Images:   imgClient,
		Uploader: uploader,
		Style:    cfg.Style,
	}
	topic = covergen.UseCase{
		Repo:     topiccover.Repo{Catalog: sqlitecatalog.NewLazy(currentDBPath)},
		Prefix:   "public/topics",
		Images:   imgClient,
		Uploader: uploader,
		Style:    cfg.Style,
	}
	return collection, topic, nil
}
