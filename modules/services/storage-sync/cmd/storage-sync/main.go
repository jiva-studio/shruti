// storage-sync mirrors Bunny Edge Storage (the source of truth) into Yandex
// Object Storage (the Russia mirror). It replaces the old GitHub `storage-sync`
// workflow, which did S3 -> Yandex via rclone; Bunny is the source now and is
// NOT S3-compatible, so the source side speaks Bunny's HTTP Storage API while
// the Yandex side is plain aws-sdk-go-v2 (S3-compatible).
//
// Change detection: Bunny exposes a per-object SHA256 `Checksum`. We stamp it
// on the Yandex object as `x-amz-meta-bunny-sha256` at upload and compare it on
// the next pass — no re-download. Legacy Yandex objects (synced from S3, no
// stamp) are matched by size so the first run doesn't re-ship the whole corpus.
//
// Runs once per SYNC_INTERVAL (0 = run once and exit).
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	smithy "github.com/aws/smithy-go"
)

const metaKey = "bunny-sha256"

type cfg struct {
	zone, key, endpoint, prefix string
	concurrency                 int
	delete, dryRun              bool
	interval                    time.Duration
	yBucket                     string
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func loadCfg() cfg {
	conc, _ := strconv.Atoi(env("SYNC_CONCURRENCY", "16"))
	if conc < 1 {
		conc = 16
	}
	iv, _ := strconv.Atoi(env("SYNC_INTERVAL", "3600"))
	return cfg{
		zone:        os.Getenv("STORAGE_ZONE"),
		key:         os.Getenv("STORAGE_KEY"),
		endpoint:    strings.TrimRight(env("STORAGE_ENDPOINT", "https://storage.bunnycdn.com"), "/"),
		prefix:      strings.TrimLeft(env("SYNC_PREFIX", ""), "/"),
		concurrency: conc,
		delete:      env("SYNC_DELETE", "false") == "true",
		dryRun:      env("DRY_RUN", "false") == "true",
		interval:    time.Duration(iv) * time.Second,
		yBucket:     os.Getenv("YANDEX_BUCKET"),
	}
}

type bunnyEntry struct {
	ObjectName  string `json:"ObjectName"`
	Length      int64  `json:"Length"`
	IsDirectory bool   `json:"IsDirectory"`
	Checksum    string `json:"Checksum"`
	Path        string `json:"Path"`
}

type obj struct {
	size   int64
	sha256 string
}

type syncer struct {
	c  cfg
	hc *http.Client
	yc *s3.Client
}

func (s *syncer) listDir(path string) ([]bunnyEntry, error) {
	url := fmt.Sprintf("%s/%s/%s", s.c.endpoint, s.c.zone, path)
	if !strings.HasSuffix(url, "/") {
		url += "/"
	}
	var lastErr error
	for attempt := 0; attempt < 4; attempt++ {
		req, _ := http.NewRequest(http.MethodGet, url, nil)
		req.Header.Set("AccessKey", s.c.key)
		resp, err := s.hc.Do(req)
		if err != nil {
			lastErr = err
			time.Sleep(time.Duration(1<<attempt) * time.Second)
			continue
		}
		if resp.StatusCode == http.StatusNotFound {
			resp.Body.Close()
			return nil, nil
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			lastErr = fmt.Errorf("list %s: HTTP %d", path, resp.StatusCode)
			time.Sleep(time.Duration(1<<attempt) * time.Second)
			continue
		}
		var entries []bunnyEntry
		err = json.NewDecoder(resp.Body).Decode(&entries)
		resp.Body.Close()
		if err != nil {
			return nil, err
		}
		return entries, nil
	}
	return nil, lastErr
}

// walk recursively lists every object under prefix into a map[key]obj.
func (s *syncer) walk(prefix string) (map[string]obj, error) {
	out := make(map[string]obj)
	var mu sync.Mutex
	sem := make(chan struct{}, s.c.concurrency)
	var wg sync.WaitGroup
	var firstErr error
	var errMu sync.Mutex

	var visit func(dir string)
	visit = func(dir string) {
		defer wg.Done()
		sem <- struct{}{}
		entries, err := s.listDir(dir)
		<-sem
		if err != nil {
			errMu.Lock()
			if firstErr == nil {
				firstErr = err
			}
			errMu.Unlock()
			return
		}
		for _, e := range entries {
			rel := strings.TrimPrefix(e.Path, "/"+s.c.zone+"/")
			rel = strings.TrimPrefix(rel, "/")
			key := rel + e.ObjectName
			if e.IsDirectory {
				wg.Add(1)
				go visit(key + "/")
			} else {
				mu.Lock()
				out[key] = obj{size: e.Length, sha256: strings.ToLower(e.Checksum)}
				mu.Unlock()
			}
		}
	}
	wg.Add(1)
	go visit(prefix)
	wg.Wait()
	return out, firstErr
}

// yandexState returns (exists, size, stampedSha256) for a key.
func (s *syncer) yandexState(ctx context.Context, key string) (bool, int64, string, error) {
	h, err := s.yc.HeadObject(ctx, &s3.HeadObjectInput{Bucket: &s.c.yBucket, Key: &key})
	if err != nil {
		var ae smithy.APIError
		if ok := asAPIErr(err, &ae); ok {
			switch ae.ErrorCode() {
			case "NotFound", "NoSuchKey", "404":
				return false, 0, "", nil
			}
		}
		return false, 0, "", err
	}
	stamp := ""
	if h.Metadata != nil {
		stamp = strings.ToLower(h.Metadata[metaKey])
	}
	return true, aws.ToInt64(h.ContentLength), stamp, nil
}

func (s *syncer) needsTransfer(ctx context.Context, key string, b obj) (bool, error) {
	exists, size, stamp, err := s.yandexState(ctx, key)
	if err != nil {
		return false, err
	}
	if !exists {
		return true, nil
	}
	if stamp != "" { // previously synced by us -> trust the sha256 stamp
		return stamp != b.sha256, nil
	}
	return size != b.size, nil // legacy (S3-synced) object -> size match = keep
}

func (s *syncer) transfer(ctx context.Context, key string, b obj) error {
	if s.c.dryRun {
		return nil
	}
	url := fmt.Sprintf("%s/%s/%s", s.c.endpoint, s.c.zone, key)
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	req.Header.Set("AccessKey", s.c.key)
	resp, err := s.hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("get %s: HTTP %d", key, resp.StatusCode)
	}
	// Spool to a temp file so the PUT body is seekable + has a known length.
	tmp, err := os.CreateTemp("", "ssync-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	if _, err := io.Copy(tmp, resp.Body); err != nil {
		return err
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return err
	}
	ct := resp.Header.Get("Content-Type")
	_, err = s.yc.PutObject(ctx, &s3.PutObjectInput{
		Bucket:        &s.c.yBucket,
		Key:           &key,
		Body:          tmp,
		ContentLength: aws.Int64(b.size),
		ContentType:   strPtrOrNil(ct),
		Metadata:      map[string]string{metaKey: b.sha256},
	})
	return err
}

func (s *syncer) runOnce(ctx context.Context) error {
	t0 := time.Now()
	log.Printf("[sync] walking Bunny %s/%s …", s.c.zone, s.c.prefix)
	src, err := s.walk(s.c.prefix)
	if err != nil {
		return fmt.Errorf("walk: %w", err)
	}
	log.Printf("[sync] bunny objects: %d", len(src))

	// Diff (parallel head checks).
	keys := make([]string, 0, len(src))
	for k := range src {
		keys = append(keys, k)
	}
	todo := s.parallelFilter(ctx, keys, src)
	log.Printf("[sync] to transfer: %d (dry_run=%v)", len(todo), s.c.dryRun)

	// Transfer (parallel).
	var copied, failed int64
	var cmu sync.Mutex
	sem := make(chan struct{}, s.c.concurrency)
	var wg sync.WaitGroup
	for _, k := range todo {
		wg.Add(1)
		go func(k string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if err := s.transfer(ctx, k, src[k]); err != nil {
				cmu.Lock()
				failed++
				cmu.Unlock()
				log.Printf("[sync] FAIL %s: %v", k, err)
				return
			}
			cmu.Lock()
			copied++
			cmu.Unlock()
		}(k)
	}
	wg.Wait()

	deleted := 0
	if s.c.delete {
		deleted, err = s.pruneStale(ctx, src)
		if err != nil {
			log.Printf("[sync] prune error: %v", err)
		}
	}

	log.Printf("[sync] done in %ds: copied=%d failed=%d deleted=%d (of %d source)",
		int(time.Since(t0).Seconds()), copied, failed, deleted, len(src))
	if failed > 0 {
		return fmt.Errorf("%d transfers failed", failed)
	}
	return nil
}

func (s *syncer) parallelFilter(ctx context.Context, keys []string, src map[string]obj) []string {
	out := make([]string, 0)
	var mu sync.Mutex
	sem := make(chan struct{}, s.c.concurrency)
	var wg sync.WaitGroup
	for _, k := range keys {
		wg.Add(1)
		go func(k string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			need, err := s.needsTransfer(ctx, k, src[k])
			if err != nil {
				log.Printf("[sync] head %s: %v", k, err)
				return
			}
			if need {
				mu.Lock()
				out = append(out, k)
				mu.Unlock()
			}
		}(k)
	}
	wg.Wait()
	return out
}

func (s *syncer) pruneStale(ctx context.Context, src map[string]obj) (int, error) {
	var stale []types.ObjectIdentifier
	p := s3.NewListObjectsV2Paginator(s.yc, &s3.ListObjectsV2Input{
		Bucket: &s.c.yBucket, Prefix: &s.c.prefix,
	})
	for p.HasMorePages() {
		page, err := p.NextPage(ctx)
		if err != nil {
			return 0, err
		}
		for _, o := range page.Contents {
			if _, ok := src[aws.ToString(o.Key)]; !ok {
				stale = append(stale, types.ObjectIdentifier{Key: o.Key})
			}
		}
	}
	n := 0
	for i := 0; i < len(stale); i += 1000 {
		end := i + 1000
		if end > len(stale) {
			end = len(stale)
		}
		if !s.c.dryRun {
			_, err := s.yc.DeleteObjects(ctx, &s3.DeleteObjectsInput{
				Bucket: &s.c.yBucket,
				Delete: &types.Delete{Objects: stale[i:end]},
			})
			if err != nil {
				return n, err
			}
		}
		n += end - i
	}
	return n, nil
}

func strPtrOrNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func asAPIErr(err error, target *smithy.APIError) bool {
	for e := err; e != nil; {
		if ae, ok := e.(smithy.APIError); ok {
			*target = ae
			return true
		}
		u, ok := e.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		e = u.Unwrap()
	}
	return false
}

func main() {
	c := loadCfg()
	if c.zone == "" || c.key == "" || c.yBucket == "" {
		log.Fatal("STORAGE_ZONE, STORAGE_KEY and YANDEX_BUCKET are required")
	}
	ctx := context.Background()
	awsCfg, err := config.LoadDefaultConfig(ctx,
		config.WithRegion(env("YANDEX_REGION", "ru-central1")),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
			os.Getenv("YANDEX_ACCESS_KEY_ID"), os.Getenv("YANDEX_SECRET_ACCESS_KEY"), "")),
	)
	if err != nil {
		log.Fatalf("aws config: %v", err)
	}
	yendpoint := env("YANDEX_ENDPOINT", "https://storage.yandexcloud.net")
	yc := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(yendpoint)
	})
	s := &syncer{c: c, hc: &http.Client{Timeout: 30 * time.Minute}, yc: yc}

	for {
		if err := s.runOnce(ctx); err != nil {
			log.Printf("[sync] run error: %v", err)
		}
		if c.interval <= 0 {
			return
		}
		time.Sleep(c.interval)
	}
}
