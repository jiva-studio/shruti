package pipeline

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// ErrUnknownTheme is returned when the theme directory in the store holds
// no .mp4 files. Callers can branch on this to render a default-themed
// reel or fail loudly.
var ErrUnknownTheme = fmt.Errorf("unknown theme")

const (
	bgListCacheTTL    = 5 * time.Minute
	bgDownloadWorkers = 4
)

// backgroundStore is the part of the store the background assembly reads.
type backgroundStore interface {
	ListFiles(ctx context.Context, dir string) ([]string, error)
	DownloadTo(ctx context.Context, key, dstPath string) error
}

// BackgroundsInput captures everything ListAndConcatBackgrounds needs.
// Kept small on purpose — the worker assembles it once per task.
type BackgroundsInput struct {
	Store       backgroundStore
	FFmpegBin   string
	Prefix      string
	Theme       string
	VideoID     string // deterministic shuffle seed
	DurationSec float64
	TempDir     string
	// LocalDir, when set, sources background clips from
	// <LocalDir>/<theme>/*.mp4 on disk instead of the store — dev/smoke
	// runs without storage access. Empty in production.
	LocalDir string
}

// ListAndConcatBackgrounds lists the theme directory in the store,
// deterministically picks enough 5-second clips to cover DurationSec,
// downloads them in parallel, and concats them with ffmpeg's concat
// demuxer (stream-copy, no re-encode). Returns the path to the
// concatenated background MP4.
func ListAndConcatBackgrounds(ctx context.Context, in BackgroundsInput) (string, error) {
	if err := os.MkdirAll(in.TempDir, 0o755); err != nil {
		return "", fmt.Errorf("mkdir %s: %w", in.TempDir, err)
	}

	nClips := int(math.Max(1, math.Ceil(in.DurationSec/5)))

	var localPaths []string
	if in.LocalDir != "" {
		// Local mode: files already on disk, no download step.
		keys, err := listLocalThemeClips(in.LocalDir, in.Theme)
		if err != nil {
			return "", fmt.Errorf("list local backgrounds: %w", err)
		}
		if len(keys) == 0 {
			return "", fmt.Errorf("%w: %s (local)", ErrUnknownTheme, in.Theme)
		}
		localPaths = pickClips(keys, in.VideoID, nClips)
	} else {
		themeDir := strings.TrimRight(in.Prefix, "/") + "/" + in.Theme
		keys, err := listThemeKeys(ctx, in.Store, themeDir)
		if err != nil {
			return "", fmt.Errorf("list backgrounds: %w", err)
		}
		if len(keys) == 0 {
			return "", fmt.Errorf("%w: %s", ErrUnknownTheme, in.Theme)
		}
		ordered := pickClips(keys, in.VideoID, nClips)
		localPaths, err = downloadAll(ctx, in.Store, ordered, in.TempDir)
		if err != nil {
			return "", fmt.Errorf("download backgrounds: %w", err)
		}
	}

	outPath := filepath.Join(in.TempDir, "bg.mp4")
	if err := concatClips(ctx, in.FFmpegBin, localPaths, in.DurationSec, outPath, in.TempDir); err != nil {
		return "", fmt.Errorf("concat backgrounds: %w", err)
	}
	return outPath, nil
}

// listLocalThemeClips returns the sorted absolute paths of *.mp4 under
// <dir>/<theme>/. Sorted so the deterministic shuffle is stable across
// runs the same way the store listing is.
func listLocalThemeClips(dir, theme string) ([]string, error) {
	themeDir := filepath.Join(dir, theme)
	entries, err := os.ReadDir(themeDir)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if strings.HasSuffix(strings.ToLower(e.Name()), ".mp4") {
			out = append(out, filepath.Join(themeDir, e.Name()))
		}
	}
	sort.Strings(out)
	return out, nil
}

// listCache caches per-directory key lists for a few minutes so repeated
// jobs against the same theme don't list the store every time.
type listEntry struct {
	keys      []string
	expiresAt time.Time
}

var (
	listCacheMu sync.Mutex
	listCache   = map[string]listEntry{}
)

func listThemeKeys(ctx context.Context, store backgroundStore, dir string) ([]string, error) {
	listCacheMu.Lock()
	e, ok := listCache[dir]
	listCacheMu.Unlock()
	if ok && e.expiresAt.After(time.Now()) {
		return e.keys, nil
	}

	files, err := store.ListFiles(ctx, dir)
	if err != nil {
		return nil, err
	}
	var keys []string
	for _, k := range files {
		if strings.HasSuffix(strings.ToLower(k), ".mp4") {
			keys = append(keys, k)
		}
	}

	listCacheMu.Lock()
	listCache[dir] = listEntry{keys: keys, expiresAt: time.Now().Add(bgListCacheTTL)}
	listCacheMu.Unlock()
	return keys, nil
}

// pickClips deterministically shuffles allKeys (Fisher-Yates seeded by
// sha256(videoID)) then returns the first nClips, cycling if the pack
// is smaller. Same algorithm as s3Backgrounds.ts.
func pickClips(allKeys []string, videoID string, nClips int) []string {
	shuffled := append([]string(nil), allKeys...)
	rng := sha256RNG(videoID)
	for i := len(shuffled) - 1; i > 0; i-- {
		j := int(rng() * float64(i+1))
		if j > i {
			j = i
		}
		shuffled[i], shuffled[j] = shuffled[j], shuffled[i]
	}
	out := make([]string, nClips)
	for i := 0; i < nClips; i++ {
		out[i] = shuffled[i%len(shuffled)]
	}
	return out
}

// sha256RNG returns a deterministic [0, 1) sequence by hashing
// seed||counter, so renders of the same video_id pick the same
// background order.
func sha256RNG(seed string) func() float64 {
	var counter uint64
	return func() float64 {
		h := sha256.New()
		_, _ = io.WriteString(h, fmt.Sprintf("%s|%d", seed, counter))
		counter++
		sum := h.Sum(nil)
		// Take first 6 bytes as a 48-bit big-endian integer.
		var b [8]byte
		copy(b[2:], sum[:6])
		big := binary.BigEndian.Uint64(b[:])
		return float64(big) / float64(uint64(1)<<48)
	}
}

func downloadAll(ctx context.Context, store backgroundStore, keys []string, destDir string) ([]string, error) {
	out := make([]string, len(keys))
	errs := make([]error, len(keys))
	jobs := make(chan int, len(keys))
	var wg sync.WaitGroup

	workers := bgDownloadWorkers
	if workers > len(keys) {
		workers = len(keys)
	}
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range jobs {
				dst := filepath.Join(destDir, fmt.Sprintf("bg_%03d.mp4", i))
				if err := store.DownloadTo(ctx, keys[i], dst); err != nil {
					errs[i] = err
					continue
				}
				out[i] = dst
			}
		}()
	}
	for i := range keys {
		jobs <- i
	}
	close(jobs)
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			return nil, err
		}
	}
	return out, nil
}
