package topics

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"golang.org/x/sync/errgroup"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/catalog"
	domaintopics "github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/domain/topics"
)

const (
	// defaultNameConcurrency caps simultaneous cluster-naming LLM calls.
	defaultNameConcurrency = 8
	// defaultNameRetries is how many attempts one cluster's naming gets on a
	// transient LLM error before the whole build aborts.
	defaultNameRetries = 3
)

// BuildUseCase builds the canonical topic vocabulary from the whole corpus of
// granular outlines: gather + dedup headings → embed → cluster → name each
// cluster (ru/en) → mint topic dict entries → write the centroids artifact. It
// does NOT assign tracks; run AssignUseCase (pipeline.run op=topics) after.
type BuildUseCase struct {
	Granular interface {
		GranularLister
		GranularReader
	}
	Embed Embedder
	Namer ClusterNamer
	Dict  DictMinter
	Vocab VocabWriter

	// K is the target number of canonical topics. Iters/Seed control the
	// clustering. MaxDistance is the cosine-distance assignment cutoff stored in
	// the vocabulary. Samples is how many representative headings per cluster
	// the namer sees.
	K           int
	Iters       int
	Seed        int64
	MaxDistance float64
	Samples     int

	// NameConcurrency / NameRetries tune the parallel cluster-naming pass.
	// Zero falls back to the defaults above.
	NameConcurrency int
	NameRetries     int
}

type BuildResult struct {
	Topics         int `json:"topics"`
	UniqueHeadings int `json:"uniqueHeadings"`
	Artifacts      int `json:"artifacts"` // granular files read
}

func (uc BuildUseCase) Run(ctx context.Context) (BuildResult, error) {
	refs, err := uc.Granular.ListGranular(ctx)
	if err != nil {
		return BuildResult{}, fmt.Errorf("list granular: %w", err)
	}
	if len(refs) == 0 {
		return BuildResult{}, fmt.Errorf("no granular outlines found — run pipeline.run op=outline first")
	}

	// Gather distinct cleaned headings across the whole corpus (dedup so each
	// distinct topic phrase is embedded once). Also collect the distinct content
	// languages present — the namer produces a name in each of them, so no
	// locale is hardcoded.
	seen := map[string]struct{}{}
	langSeen := map[string]struct{}{}
	var titles []string
	read := 0
	for _, ref := range refs {
		entries, err := uc.Granular.ReadGranularOutline(ctx, ref.TrackID, ref.Language)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return BuildResult{}, fmt.Errorf("read granular %s/%s: %w", ref.TrackID, ref.Language, err)
		}
		read++
		if l := strings.TrimSpace(ref.Language); l != "" {
			langSeen[l] = struct{}{}
		}
		for _, e := range entries {
			t := cleanTitle(e.Title)
			if t == "" {
				continue
			}
			if _, ok := seen[t]; !ok {
				seen[t] = struct{}{}
				titles = append(titles, t)
			}
		}
	}
	if len(titles) < uc.K {
		return BuildResult{}, fmt.Errorf("only %d distinct headings for k=%d — lower k or generate more outlines", len(titles), uc.K)
	}
	languages := make([]string, 0, len(langSeen))
	for l := range langSeen {
		languages = append(languages, l)
	}
	sort.Strings(languages)

	vecs, err := uc.Embed.Embed(ctx, titles)
	if err != nil {
		return BuildResult{}, fmt.Errorf("embed headings: %w", err)
	}
	norm := normalizeAll(vecs)
	res := kmeansCosine(norm, uc.K, uc.Iters, uc.Seed)
	k := len(res.Centroids)

	// Group title indices per cluster for representative naming.
	members := make([][]int, k)
	for i, c := range res.Assignments {
		if c >= 0 && c < k {
			members[c] = append(members[c], i)
		}
	}

	// Name every cluster — the slow, failure-prone LLM step — in parallel and
	// with a retry, BEFORE touching the catalog. Doing all naming first means a
	// transient LLM failure aborts the whole build cleanly, without leaving
	// half-created orphan topics behind (which a re-run would then duplicate).
	conc := uc.NameConcurrency
	if conc <= 0 {
		conc = defaultNameConcurrency
	}
	retries := uc.NameRetries
	if retries <= 0 {
		retries = defaultNameRetries
	}
	names := make([]domaintopics.Names, k)
	g, gctx := errgroup.WithContext(ctx)
	g.SetLimit(conc)
	for c := 0; c < k; c++ {
		c := c
		g.Go(func() error {
			samples := representatives(members[c], norm, res.Centroids[c], titles, uc.Samples)
			n, err := nameClusterWithRetry(gctx, uc.Namer, samples, languages, retries)
			if err != nil {
				return fmt.Errorf("name cluster %d: %w", c, err)
			}
			names[c] = n
			return nil
		})
	}
	if err := g.Wait(); err != nil {
		return BuildResult{}, err
	}

	// All names resolved — now mint the topic dict entries and the centroid
	// vocabulary (fast, local catalog writes), and persist the vocabulary last.
	voc := domaintopics.Vocabulary{
		Dim:         len(norm[0]),
		EmbedModel:  uc.Embed.Model(),
		MaxDistance: uc.MaxDistance,
		Centroids:   make([]domaintopics.Centroid, 0, k),
	}
	for c := 0; c < k; c++ {
		id, err := uc.Dict.Create(ctx, catalog.KindTopic, names[c].Full, names[c].Short)
		if err != nil {
			return BuildResult{}, fmt.Errorf("create topic %d: %w", c, err)
		}
		voc.Centroids = append(voc.Centroids, domaintopics.Centroid{TopicID: id, Vector: res.Centroids[c]})
	}

	if err := uc.Vocab.WriteVocabulary(ctx, voc); err != nil {
		return BuildResult{}, fmt.Errorf("write vocabulary: %w", err)
	}
	return BuildResult{Topics: k, UniqueHeadings: len(titles), Artifacts: read}, nil
}

// nameClusterWithRetry calls the namer up to `attempts` times, retrying on a
// transient error with a short exponential backoff. Honours context cancellation
// (errgroup cancels gctx as soon as any sibling cluster fails).
func nameClusterWithRetry(
	ctx context.Context,
	namer ClusterNamer,
	samples, languages []string,
	attempts int,
) (domaintopics.Names, error) {
	var lastErr error
	for a := 0; a < attempts; a++ {
		if a > 0 {
			backoff := time.Duration(1<<uint(a-1)) * time.Second // 1s, 2s, 4s…
			if backoff > 8*time.Second {
				backoff = 8 * time.Second
			}
			select {
			case <-ctx.Done():
				return domaintopics.Names{}, ctx.Err()
			case <-time.After(backoff):
			}
		}
		n, err := namer.NameCluster(ctx, samples, languages)
		if err == nil {
			return n, nil
		}
		lastErr = err
	}
	return domaintopics.Names{}, lastErr
}

// representatives returns up to n cluster-member titles closest to the centroid
// — the clearest examples for the namer.
func representatives(idx []int, vecs [][]float32, centroid []float32, titles []string, n int) []string {
	sort.Slice(idx, func(a, b int) bool {
		return dot(vecs[idx[a]], centroid) > dot(vecs[idx[b]], centroid)
	})
	if len(idx) > n {
		idx = idx[:n]
	}
	out := make([]string, len(idx))
	for i, j := range idx {
		out[i] = titles[j]
	}
	return out
}

// cleanTitle trims a heading and drops obvious non-topics (empties, stubs). The
// structured-output outline prompt already constrains titles to 3-6 word topic
// phrases, so this is a light guard, not heavy NLP.
func cleanTitle(s string) string {
	s = strings.TrimSpace(s)
	if len([]rune(s)) < 4 {
		return ""
	}
	return s
}
