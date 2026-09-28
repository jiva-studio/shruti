// Package container is the composition root of shruti-mcp: it opens every
// long-lived resource once, wires the adapters into the use cases, and closes
// them in reverse order.
package container

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"

	"github.com/jiva-studio/shruti/catalogdb"
	adminconfigapp "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/adminconfig"
	alignpdfuc "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/align"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/assetsync"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/audiodenoise"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/audiotag"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/authorprofile"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/collectioncrud"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/collectiongroupcrud"
	configpublish "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/configpublish"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/dictcrud"
	catalogproactive "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/proactive"
	catalogpublish "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/publish"
	catalogrefresh "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/refresh"
	catalogregions "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/regions"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/commit"
	configregistry "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/config/registry"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/extractmeta"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/ingest"
	attributionapp "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/library/attribution"
	librarymedia "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/library/media"
	librarypublish "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/library/publish"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/normalize"
	outlineuc "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/outline"
	pendingrefresh "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/pending/refresh"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/promote"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/registeraudio"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/runner"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/runpipeline"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/selecttracks"
	titleuc "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/title"
	topicsapp "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/topics"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/transcribe"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/config"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/catalog"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/domain/pipeline"
	adminconfigrt "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/adminconfig/runtime"
	fsartifact "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/artifact/fs"
	fsaudio "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/audiostore/fs"
	sqlitecatalog "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/catalog/sqlite"
	httpcdn "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/cdn/http"
	systemclock "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/clock"
	execdenoise "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/denoise/exec"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/fetch"
	osfs "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/fs/os"
	sha256hash "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/hashing/sha256"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/ids/nanoid"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/imageutil"
	sqliteregistry "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/lakeregistry/sqlite"
	sqlitelibrary "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/library/sqlite"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/loudness/ffmpeg"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/metadata/canonical"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/metadata/filemeta"
	fsoutline "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/outline/fs"
	sqlitepending "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/pending/sqlite"
	fsbatchstore "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/reviewbatch/fs"
	sqliteruns "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/runregistry/sqlite"
	id3v2tagger "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/tagger/id3v2"
	fstopics "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/topics/fs"
	fstranscript "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/transcriptstore/fs"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/mcp/tools"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/worker"
)

// Options are the process-level knobs that are not part of the YAML config.
type Options struct {
	Workers               int // file-level pipeline workers
	TranscribeConcurrency int // concurrent transcribe calls
}

// Container holds everything Build opened.
type Container struct {
	Deps tools.Deps
	Pool *worker.Pool

	closers []func() error
}

// Paths of the artifacts the container opens under the output tree.
func catalogPath(out string) string { return filepath.Join(out, "artifacts", "catalog", "current.db") }
func libraryPath(out string) string { return filepath.Join(out, "artifacts", "library", "library.db") }
func pendingPath(out string) string { return filepath.Join(out, "artifacts", "pending", "pending.db") }

// OpenCatalog opens current.db under the output tree, migrating it once.
func OpenCatalog(ctx context.Context, out string) (*sqlitecatalog.Store, error) {
	return sqlitecatalog.OpenStore(ctx, catalogPath(out))
}

// Build opens the databases and sidecars and wires the MCP tool
// dependencies. On error everything opened so far is closed again.
func Build(ctx context.Context, cfg *config.Config, opts Options) (_ *Container, err error) {
	c := &Container{}
	defer func() {
		if err != nil {
			err = errors.Join(err, c.Close())
		}
	}()

	if err := ensureOutTree(cfg.Out); err != nil {
		return nil, err
	}

	minter := nanoid.New()
	registry, err := sqliteregistry.New(ctx, cfg.DB, minter)
	if err != nil {
		return nil, fmt.Errorf("open lake registry: %w", err)
	}
	c.onClose(registry.Close)
	if n, err := registry.MarkInterruptedAsFailed(ctx); err != nil {
		return nil, fmt.Errorf("recovery: %w", err)
	} else if n > 0 {
		log.Printf("[recovery] flipped %d running stages → failed", n)
	}

	catalogStore, err := OpenCatalog(ctx, cfg.Out)
	if err != nil {
		return nil, fmt.Errorf("open catalog: %w", err)
	}
	c.onClose(catalogStore.Close)
	libraryStore, err := sqlitelibrary.OpenStore(ctx, libraryPath(cfg.Out))
	if err != nil {
		return nil, fmt.Errorf("open library: %w", err)
	}
	c.onClose(libraryStore.Close)
	pendingStore, err := sqlitepending.OpenStore(ctx, pendingPath(cfg.Out))
	if err != nil {
		return nil, fmt.Errorf("open pending queue: %w", err)
	}
	c.onClose(pendingStore.Close)

	// Runs survive restarts; a run left non-terminal by the previous process
	// is marked failed when the registry opens. Cancel hooks live in memory
	// only, so no cancel can reach a run from before the restart.
	runRegistry, err := sqliteruns.New(ctx, cfg.RunsDB)
	if err != nil {
		return nil, fmt.Errorf("open runs.db: %w", err)
	}
	c.onClose(runRegistry.Close)

	sysClock := systemclock.New()
	audioStore := fsaudio.New(cfg.Out)
	ffTool := ffmpeg.New(cfg.FFmpeg.Bin)
	cdnSrc := httpcdn.New(cfg.CDN.ReadBaseURL)
	// One mutex for every writer of the catalog file and config.json:
	// refresh, publish, proactive, regions and the library publish.
	catalogOpMutex := &sync.Mutex{}

	llmExtractor, err := buildMetadataExtractor(cfg.Metadata)
	if err != nil {
		return nil, err
	}
	// A track imported with real metadata carries a meta.json next to the
	// mp3; dedup-canonical files under <lake>/sorted/<lang>/ parse without an
	// LLM; everything else falls through to the LLM extractor.
	extractor := filemeta.Extractor{
		InDir: cfg.In,
		Fallback: canonical.ChainExtractor{
			InDir:    cfg.In,
			Fallback: llmExtractor,
		},
	}

	publishTargets, bunnyTarget := buildPublishTargets(ctx, cfg.S3)

	// Artifacts are written to the lake only; assets.sync ships them with the
	// public assets, so a review chunk never waits on an upload.
	artifactWriter := fsartifact.New(cfg.Out)
	transcriptStore := fstranscript.New(cfg.Out, artifactWriter)

	// Track selection reads through the registry's own pool so it does not
	// contend with the writer for the lake lock.
	trackSelector := sqliteregistry.NewTrackSelector(registry.DB(), cfg.In, cfg.Out, transcriptStore)
	runRunner := runner.New(runRegistry, sysClock)

	transcribeRegistry, err := buildTranscribeRegistry(cfg.Transcribe, opts.TranscribeConcurrency)
	if err != nil {
		return nil, err
	}
	adminruntime := &adminconfigrt.Adapter{Transcribers: transcribeRegistry, Config: cfg}

	sentenceSplitter := buildSentenceSplitter(ctx, cfg.Review.Sentencer)
	if sentenceSplitter != nil {
		c.onClose(sentenceSplitter.Close)
	}
	pdfAligner := buildPDFAligner(ctx, cfg.Review.AlignPDF)
	if pdfAligner != nil {
		c.onClose(pdfAligner.Close)
	}

	reviewRegistry, err := buildReviewRegistry(cfg.Review)
	if err != nil {
		return nil, err
	}
	reviewGlossary := loadGlossaryOrNil(cfg.Review.Glossary.Path)
	reviewBatchJobs := fsbatchstore.New(cfg.Out)
	reviewBatcher, err := buildReviewBatcher(cfg.Review.Batch)
	if err != nil {
		return nil, err
	}
	throttleReviewers(reviewRegistry, cfg.Review.MaxConcurrentLLM)

	// The resolver default is usually a Haiku-class model for short match
	// decisions.
	resCfg, ok := cfg.Resolver.Providers[cfg.Resolver.Default]
	if !ok {
		return nil, fmt.Errorf("resolver: default %q not in providers map", cfg.Resolver.Default)
	}
	resolverChain, err := buildResolverChain(cfg.Resolver.Default, resCfg)
	if err != nil {
		return nil, err
	}
	translator, err := buildDictTranslator(resCfg)
	if err != nil {
		return nil, err
	}
	titleExtractor, err := buildTitleExtractor(resCfg)
	if err != nil {
		return nil, err
	}
	outlineGen, err := buildOutlineGenerator(cfg.Outline)
	if err != nil {
		return nil, err
	}
	outlineCompress, err := resolveOutlineCompressor(cfg.Outline.Compress)
	if err != nil {
		return nil, err
	}
	outlineBatcher, err := buildOutlineBatcher(cfg.Outline.Batch)
	if err != nil {
		return nil, err
	}

	// The fuzzy index prefilters dictionary candidates for the LLM resolver;
	// it is derived from the catalog and rebuilt after dictionary writes.
	fuzzyIndex := sqlitecatalog.NewFuzzyIndex(catalogStore)
	dictCRUDUC := dictcrud.UseCase{Catalog: catalogStore, FuzzyIndex: fuzzyIndex, Minter: minter}

	outlineArtifacts := fsoutline.New(artifactWriter)
	topicCentroids := fstopics.New(artifactWriter)
	topicsDeps := buildTopicsDeps(cfg, outlineArtifacts, topicCentroids, dictCRUDUC, catalogStore)

	osFS := osfs.New()
	hasher := sha256hash.New()

	// Commit ends with tagging the public mp3 from the committed catalog
	// state; track_tag_audio re-runs it after a manual metadata edit.
	audioTagUC := audiotag.UseCase{Catalog: catalogStore, Audio: audioStore, Tagger: id3v2tagger.New()}
	commitUC := commit.UseCase{
		Registry:    registry,
		Audio:       audioStore,
		Transcripts: transcriptStore,
		Catalog:     catalogStore,
		FS:          osFS,
		OutDir:      cfg.Out,
		AudioTag:    &audioTagUC,
		OpMutex:     catalogOpMutex,
	}
	// Without the aligner sidecar, Aligner stays nil and review never takes
	// the PDF branch.
	alignPDFUC := alignpdfuc.UseCase{
		Registry:    registry,
		Transcripts: transcriptStore,
		Aligner:     alignerOrNil(pdfAligner),
		OutDir:      cfg.Out,
		Clock:       sysClock,
	}

	assetUploader, err := buildAssetUploader(ctx, cfg.S3, bunnyTarget)
	if err != nil {
		return nil, err
	}
	coverGen, topicCoverGen, err := buildCoverGenerators(cfg.Images, assetUploader, catalogStore)
	if err != nil {
		return nil, err
	}
	topicsDeps.Cover = topicCoverGen
	topicsDeps.CoverBuild = topicsapp.CoverBuildUseCase{Lister: catalogStore, Cover: topicCoverGen}

	configRegistry := configregistry.New(configregistry.ValidateDeps{
		TopicExists: func(ctx context.Context, id string) (bool, error) {
			_, ok, err := catalogStore.GetDict(ctx, catalog.KindTopic, id)
			return ok, err
		},
	})
	if err := configRegistry.Register(configregistry.OnboardingTopicsDescriptor()); err != nil {
		return nil, fmt.Errorf("register descriptor: %w", err)
	}

	setTrackMetadata := commit.SetTrackMetadataUseCase{Registry: registry, Catalog: catalogStore}
	deps := tools.Deps{
		Registry:        registry,
		Transcripts:     transcriptStore,
		ReviewBatchJobs: reviewBatchJobs,
		Ingest: ingest.UseCase{
			Registry:   registry,
			Audio:      audioStore,
			FS:         osFS,
			Hasher:     hasher,
			Rollbacker: commitUC,
			Meta:       extractor,
			Clock:      sysClock,
		},
		Normalize: normalize.UseCase{Registry: registry, Audio: audioStore, Normalizer: ffTool},
		AudioDenoise: audiodenoise.UseCase{
			Audio:       audioStore,
			Probe:       ffTool,
			Denoiser:    execdenoise.New(cfg.Denoiser.PythonBin, cfg.Denoiser.Script),
			Catalog:     catalogStore,
			Transcripts: transcriptStore,
		},
		RegisterAudio: registeraudio.UseCase{Catalog: catalogStore},
		Catalog: tools.CatalogDeps{
			Refresh: catalogrefresh.UseCase{
				OutDir:          cfg.Out,
				SupportedScheme: catalogdb.Scheme,
				CDN:             cdnSrc,
				SchemeReader:    sqlitecatalog.NewSchemeReader(),
				Catalog:         catalogStore,
				OpMutex:         catalogOpMutex,
				Clock:           sysClock,
			},
			Repo: catalogStore,
		},
		ConfigStore: tools.ConfigDeps{Settings: catalogStore, Registry: configRegistry},
		Wisdom:      tools.WisdomDeps{Catalog: catalogStore, Minter: minter},
		Metadata: extractmeta.UseCase{
			Registry:        registry,
			Audio:           audioStore,
			Probe:           ffTool,
			Extractor:       extractor,
			Catalog:         catalogStore,
			FuzzyIndex:      fuzzyIndex,
			Resolver:        resolverChain,
			Minter:          minter,
			Translator:      translator,
			OutDir:          cfg.Out,
			InDir:           cfg.In,
			DefaultLanguage: cfg.DefaultLanguage,
			Artifacts:       artifactWriter,
		},
		Transcribe: transcribe.UseCase{
			Registry:     registry,
			Audio:        audioStore,
			Transcripts:  transcriptStore,
			Transcribers: transcribeRegistry,
		},
		AlignPDF: alignPDFUC,
		Outline: outlineuc.UseCase{
			Transcripts: transcriptStore,
			LLM:         outlineGen,
			Catalog:     catalogStore,
			Granular:    outlineArtifacts,
			Compress:    outlineCompress,
			Batch:       outlineBatcher,
			BatchJobs:   outlineuc.NewBatchStore(cfg.Out),
			MaxTokens:   cfg.Outline.MaxTokens,
			Clock:       sysClock,
		},
		RefreshTitle: titleuc.UseCase{
			Registry:         registry,
			Transcripts:      transcriptStore,
			Aligner:          alignerOrNil(pdfAligner),
			LLM:              titleExtractor,
			SetTrackMetadata: setTrackMetadata,
			OutDir:           cfg.Out,
		},
		Review:           buildReviewUseCase(cfg, registry, transcriptStore, reviewRegistry, sentenceSplitter, pdfAligner, &alignPDFUC, reviewGlossary, reviewBatcher, reviewBatchJobs, sysClock),
		Commit:           commitUC,
		AudioTag:         audioTagUC,
		SetTrackMetadata: setTrackMetadata,
		SelectTracks:     selecttracks.UseCase{Selector: trackSelector},
		Runs:             runRegistry,
		Runner:           runRunner,
		DictCRUD:         tools.DictCRUDDeps{UseCase: dictCRUDUC},
		Topics:           topicsDeps,
		CollectionCRUD: tools.CollectionCRUDDeps{
			UseCase: collectioncrud.UseCase{Catalog: catalogStore, Minter: minter},
			Cover:   coverGen,
		},
		CollectionGroupCRUD: tools.CollectionGroupCRUDDeps{
			UseCase: collectiongroupcrud.UseCase{Catalog: catalogStore, Minter: minter},
		},
		AuthorProfile: tools.AuthorProfileDeps{UseCase: authorprofile.UseCase{
			Catalog:  catalogStore,
			Source:   fetch.New(),
			JPEG:     imageutil.JPEG{},
			Uploader: assetUploader,
		}},
		Find:   tools.FindDeps{Catalog: catalogStore, Resolver: resolverChain, TopN: cfg.Resolver.CandidatesTopN},
		InDir:  cfg.In,
		OutDir: cfg.Out,
		Config: cfg,
		AdminConfig: adminconfigapp.Service{
			Endpoints: adminruntime,
			Defaults:  adminruntime,
			Snap:      adminruntime,
		},
	}

	stageLimits := map[pipeline.Stage]int{}
	for name, n := range cfg.Concurrency {
		stageLimits[pipeline.Stage(name)] = n
	}
	deps.Pipeline = runpipeline.UseCase{
		Gate:            runpipeline.NewGate(stageLimits),
		Registry:        registry,
		Ingest:          deps.Ingest,
		Normalize:       deps.Normalize,
		Metadata:        deps.Metadata,
		Transcribe:      deps.Transcribe,
		Review:          deps.Review,
		Commit:          deps.Commit,
		DefaultLanguage: cfg.DefaultLanguage,
	}
	c.Pool = worker.New(deps.Pipeline, opts.Workers, 0)
	deps.Pool = c.Pool

	deps.Publish = catalogpublish.UseCase{
		OutDir:          cfg.Out,
		SupportedScheme: catalogdb.Scheme,
		Catalog:         catalogStore,
		Targets:         publishTargets,
		OpMutex:         catalogOpMutex,
		Clock:           sysClock,
	}
	deps.AssetSync = tools.AssetSyncDeps{
		UseCase: assetsync.UseCase{OutDir: cfg.Out, Targets: publishTargets, Registry: registry},
	}
	deps.Library = tools.LibraryDeps{Repo: libraryStore}
	attribTranslator, err := buildAttributionTranslator(resCfg)
	if err != nil {
		return nil, err
	}
	deps.LibraryAttribution = tools.LibraryAttributionDeps{
		UseCase: attributionapp.UseCase{
			Repo:       libraryStore,
			Translator: attribTranslator,
			Minter:     minter,
			Langs:      []string{"ru", "en"},
		},
		Library: libraryStore,
	}
	deps.LibraryImport = tools.LibraryImportDeps{
		UseCase: librarymedia.UseCase{Repo: libraryStore, Targets: publishTargets, Minter: minter},
	}
	deps.LibraryPublish = tools.LibraryPublishDeps{
		UseCase: librarypublish.UseCase{
			OutDir:  cfg.Out,
			Targets: publishTargets,
			OpMutex: catalogOpMutex,
			Clock:   sysClock,
		},
	}

	// Corpus promotion: pending.db is fetched from the CDN, read here, and
	// an approval commits into the catalog through the same store.
	deps.Pending = tools.PendingDeps{
		Refresh: pendingrefresh.UseCase{
			OutDir:   cfg.Out,
			CDN:      cdnSrc,
			Verifier: sqlitepending.NewVerifier(),
			Queue:    pendingStore,
			OpMutex:  &sync.Mutex{},
		},
		Reader:  pendingStore,
		Approve: promote.UseCase{Pending: pendingStore, Catalog: catalogStore},
	}
	deps.Proactive = tools.ProactiveDeps{UseCase: catalogproactive.UseCase{OutDir: cfg.Out, Mu: catalogOpMutex}}
	deps.Regions = tools.RegionsDeps{UseCase: catalogregions.UseCase{OutDir: cfg.Out, Mu: catalogOpMutex}}
	deps.ConfigPublish = tools.ConfigPublishDeps{
		UseCase: configpublish.UseCase{OutDir: cfg.Out, Targets: publishTargets, OpMutex: catalogOpMutex},
	}
	c.Deps = deps

	// A first start has no catalog yet; fetch it rather than serve tools
	// that can only answer "not refreshed".
	if _, err := os.Stat(catalogStore.Path()); errors.Is(err, os.ErrNotExist) {
		log.Printf("[catalog] current.db missing — auto-refresh from CDN")
		if res, err := deps.Catalog.Refresh.Run(ctx, false); err != nil {
			log.Printf("[catalog] auto-refresh failed: %v (continuing; call catalog_refresh manually)", err)
		} else {
			log.Printf("[catalog] downloaded version=%d scheme=%d", res.Version, res.Scheme)
		}
	}
	return c, nil
}

func (c *Container) onClose(fn func() error) { c.closers = append(c.closers, fn) }

// Close releases everything Build opened, newest first. Stop the worker pool
// before calling it: a worker still running would find its databases closed.
func (c *Container) Close() error {
	var errs []error
	for i := len(c.closers) - 1; i >= 0; i-- {
		errs = append(errs, c.closers[i]())
	}
	c.closers = nil
	return errors.Join(errs...)
}

func ensureOutTree(out string) error {
	for _, p := range []string{
		filepath.Join(out, "public", "tracks"),
		filepath.Join(out, "artifacts", "tracks"),
		filepath.Join(out, "artifacts", "lake"),
		filepath.Join(out, "artifacts", "catalog"),
	} {
		if err := os.MkdirAll(p, 0o755); err != nil {
			return fmt.Errorf("mkdir %s: %w", p, err)
		}
	}
	return nil
}
