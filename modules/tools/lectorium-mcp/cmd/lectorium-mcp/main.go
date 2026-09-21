package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"flag"
	"fmt"
	"log"
	"net/http"
	_ "net/http/pprof"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"sync"
	"syscall"
	"time"

	adminconfigapp "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/adminconfig"
	alignpdfuc "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/align"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/assetsync"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/audiodenoise"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/audiotag"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/catalog/authorprofile"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/catalog/collectioncrud"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/catalog/collectiongroupcrud"
	configpublish "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/catalog/configpublish"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/catalog/dictcrud"
	catalogproactive "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/catalog/proactive"
	catalogpublish "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/catalog/publish"
	catalogrefresh "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/catalog/refresh"
	catalogregions "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/catalog/regions"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/commit"
	configregistry "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/config/registry"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/extractmeta"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/ingest"
	attributionapp "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/library/attribution"
	librarymedia "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/library/media"
	librarypublish "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/library/publish"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/normalize"
	outlineuc "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/outline"
	pendingrefresh "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/pending/refresh"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/promote"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/registeraudio"
	reviewuc "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/review"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/runner"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/runpipeline"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/selecttracks"
	titleuc "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/title"
	topicsapp "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/topics"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/transcribe"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/config"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/catalog"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/domain/pipeline"
	adminconfigrt "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/adminconfig/runtime"
	pythonalign "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/align/python"
	fsartifact "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/artifact/fs"
	fsaudio "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/audiostore/fs"
	sqlitecatalog "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/catalog/sqlite"
	httpcdn "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/cdn/http"
	systemclock "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/clock"
	execdenoise "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/denoise/exec"
	osfs "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/fs/os"
	sha256hash "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/hashing/sha256"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/ids/nanoid"
	sqliteregistry "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/lakeregistry/sqlite"
	sqlitelibrary "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/library/sqlite"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/loudness/ffmpeg"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/metadata/canonical"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/metadata/filemeta"
	fsoutline "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/outline/fs"
	sqlitepending "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/pending/sqlite"
	fsbatchstore "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/reviewbatch/fs"
	sqliteruns "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/runregistry/sqlite"
	razdelsplit "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/sentencesplit/razdel"
	id3v2tagger "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/tagger/id3v2"
	fstopics "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/topics/fs"
	fstranscript "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/infra/transcriptstore/fs"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/mcp/tools"
	alignport "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/ports/align"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/worker"
	glossary "github.com/jiva-studio/lectorium/pipeline/glossary"
	glossaryport "github.com/jiva-studio/lectorium/pipeline/ports/glossary"
	"github.com/jiva-studio/lectorium/pipeline/ports/sentencesplit"
)

// runBackfillAssetHashes opens current.db and (re)hashes every published
// transcript referenced by track_variants, upserting asset_hashes. Idempotent
// and re-runnable: the chat indexer reads this table from the published db to
// discover + diff transcripts instead of listing S3 (Bunny has no anonymous
// listing). Reads each transcript file from <out>/<transcript_path>.
func runBackfillAssetHashes(outDir string) error {
	dbPath := filepath.Join(outDir, "artifacts", "catalog", "current.db")
	db, err := sql.Open("sqlite3", "file:"+dbPath+"?_busy_timeout=15000")
	if err != nil {
		return fmt.Errorf("open %s: %w", dbPath, err)
	}
	defer db.Close()
	ctx := context.Background()

	for _, ddl := range []string{
		`CREATE TABLE IF NOT EXISTS asset_hashes (
			path TEXT NOT NULL PRIMARY KEY, sha256 TEXT NOT NULL,
			track_id TEXT, language TEXT, kind TEXT)`,
		`CREATE INDEX IF NOT EXISTS idx_asset_hashes_kind ON asset_hashes(kind)`,
	} {
		if _, err := db.ExecContext(ctx, ddl); err != nil {
			return fmt.Errorf("ensure asset_hashes: %w", err)
		}
	}

	rows, err := db.QueryContext(ctx, `SELECT track_id, language, transcript_path
		FROM track_variants WHERE transcript_path IS NOT NULL AND transcript_path <> ''`)
	if err != nil {
		return fmt.Errorf("select variants: %w", err)
	}
	defer rows.Close()
	type rec struct{ trackID, lang, path string }
	var recs []rec
	for rows.Next() {
		var r rec
		if err := rows.Scan(&r.trackID, &r.lang, &r.path); err != nil {
			return err
		}
		recs = append(recs, r)
	}
	if err := rows.Err(); err != nil {
		return err
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmt, err := tx.PrepareContext(ctx, `INSERT INTO asset_hashes (path, sha256, track_id, language, kind)
		VALUES (?, ?, ?, ?, 'transcript')
		ON CONFLICT(path) DO UPDATE SET sha256=excluded.sha256, track_id=excluded.track_id,
			language=excluded.language, kind=excluded.kind`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	var done, missing int
	for _, r := range recs {
		b, err := os.ReadFile(filepath.Join(outDir, filepath.FromSlash(r.path)))
		if err != nil {
			missing++
			continue
		}
		sum := sha256.Sum256(b)
		if _, err := stmt.ExecContext(ctx, r.path, hex.EncodeToString(sum[:]), r.trackID, r.lang); err != nil {
			return fmt.Errorf("upsert %s: %w", r.path, err)
		}
		done++
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "[backfill] asset_hashes: %d transcripts hashed, %d files missing (of %d variants)\n",
		done, missing, len(recs))
	return nil
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	configPath := flag.String("config", "", "path to YAML config (default: ./lectorium-mcp.yaml or ~/.config/lectorium-mcp/config.yaml)")
	doServe := flag.Bool("serve", true, "run the MCP HTTP server (default true)")
	addr := flag.String("addr", "127.0.0.1:8081", "HTTP listen address for MCP transports (streamable + SSE)")
	heartbeat := flag.Duration("heartbeat-interval", 15*time.Second, "MCP keepalive heartbeat for streamable HTTP / SSE")
	workers := flag.Int("workers", 4, "number of file-level pipeline workers")
	transcribeConcurrency := flag.Int("transcribe-concurrency", 2, "max concurrent transcribe calls (matches M-box worker count)")
	backfillHashes := flag.Bool("backfill-asset-hashes", false, "scan published transcripts under <out> and (re)populate asset_hashes in current.db, then exit")
	flag.Parse()

	path, err := resolveConfigPath(*configPath)
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}
	cfg, err := config.Load(path)
	if err != nil {
		return fmt.Errorf("config load: %w", err)
	}

	if *backfillHashes {
		if err := runBackfillAssetHashes(cfg.Out); err != nil {
			return fmt.Errorf("backfill-asset-hashes: %w", err)
		}
		return nil
	}

	if !*doServe {
		printConfig(path, cfg)
		return nil
	}

	ctx := context.Background()

	if err := ensureOutTree(cfg.Out); err != nil {
		return err
	}

	// Adapters.
	minter := nanoid.New()
	registry, err := sqliteregistry.New(ctx, cfg.DB, minter)
	if err != nil {
		return fmt.Errorf("open lake registry: %w", err)
	}
	defer registry.Close()

	if n, err := registry.MarkInterruptedAsFailed(ctx); err != nil {
		return fmt.Errorf("recovery: %w", err)
	} else if n > 0 {
		fmt.Fprintf(os.Stderr, "[recovery] flipped %d running stages → failed\n", n)
	}

	audioStore := fsaudio.New(cfg.Out)
	ffTool := ffmpeg.New(cfg.FFmpeg.Bin)

	cdnSrc := httpcdn.New(cfg.CDN.ReadBaseURL)
	catalogOpMutex := &sync.Mutex{}
	currentDBPath := filepath.Join(cfg.Out, "artifacts", "catalog", "current.db")
	libraryDBPath := filepath.Join(cfg.Out, "artifacts", "library", "library.db")
	pendingDBPath := filepath.Join(cfg.Out, "artifacts", "pending", "pending.db")

	llmExtractor, err := buildMetadataExtractor(cfg.Metadata)
	if err != nil {
		return err
	}
	// A track imported with real metadata carries a meta.json next to the mp3
	// and needs no parsing at all. Dedup-canonical files (paths under
	// <lake>/sorted/<lang>/...) parse deterministically without an LLM call;
	// everything else falls through to the LLM extractor.
	extractor := filemeta.Extractor{
		InDir: cfg.In,
		Fallback: canonical.ChainExtractor{
			InDir:    cfg.In,
			Fallback: llmExtractor,
		},
	}

	// AWS is required (read+write); Yandex is a mirror; artifact stores share
	// these uploaders with the publish path.
	publishTargets, bunnyTarget := buildPublishTargets(ctx, cfg.S3)

	// Lake-only on purpose: artifacts reach the publish targets through
	// assets.sync alongside the public assets. Uploading each one as it was
	// written put a network round trip inside every review chunk.
	artifactWriter := fsartifact.New(cfg.Out)

	transcriptStore := fstranscript.New(cfg.Out, artifactWriter)

	// trackSelector resolves track.Selector against the same SQLite handle
	// the registry uses, so reads land on the same connection pool and
	// don't fight the writer for the lake-write lock.
	trackSelector := sqliteregistry.NewTrackSelector(registry.DB(), cfg.In, cfg.Out, transcriptStore)
	selectTracksUC := selecttracks.UseCase{Selector: trackSelector}

	// Run registry + runner. SQLite-backed (out/artifacts/lake/runs.db by
	// default): runs survive daemon restarts, with non-terminal rows from
	// a previous process auto-reconciled to state=failed,
	// error="daemon restart" on registry construction. Cancel hooks live
	// in memory only — they can't be persisted, so post-restart runs are
	// guaranteed to be in a terminal state before any cancel could fire.
	runRegistry, err := sqliteruns.New(ctx, cfg.RunsDB)
	if err != nil {
		return fmt.Errorf("open runs.db: %w", err)
	}
	defer runRegistry.Close()
	sysClock := systemclock.New()
	runRunner := runner.New(runRegistry, sysClock)

	transcribeRegistry, err := buildTranscribeRegistry(cfg.Transcribe, *transcribeConcurrency)
	if err != nil {
		return err
	}

	// Admin-config runtime adapter: implements the EndpointMutator,
	// DefaultMutator, and SnapshotProvider ports by reaching into the
	// transcriber registry. Wired into tools.Deps.AdminConfig below.
	adminruntime := &adminconfigrt.Adapter{
		Transcribers: transcribeRegistry,
		Config:       cfg,
	}

	sentenceSplitter := buildSentenceSplitter(ctx, cfg.Review.Sentencer)
	if sentenceSplitter != nil {
		defer sentenceSplitter.Close()
	}

	pdfAligner := buildPDFAligner(ctx, cfg.Review.AlignPDF)
	if pdfAligner != nil {
		defer pdfAligner.Close()
	}

	reviewRegistry, err := buildReviewRegistry(cfg.Review)
	if err != nil {
		return err
	}

	// Wall-clock here is mostly waiting, not computing, so the block and mutex
	// profiles are the ones that answer "where did the time go".
	if os.Getenv("LECTORIUM_PPROF") != "" {
		runtime.SetBlockProfileRate(1000)
		runtime.SetMutexProfileFraction(10)
		go func() {
			addr := os.Getenv("LECTORIUM_PPROF")
			fmt.Fprintf(os.Stderr, "[pprof] listening on %s\n", addr)
			_ = http.ListenAndServe(addr, nil)
		}()
	}

	reviewGlossary := loadGlossaryOrNil(cfg.Review.Glossary.Path)

	reviewBatchJobs := fsbatchstore.New(cfg.Out)
	reviewBatcher, err := buildReviewBatcher(cfg.Review.Batch)
	if err != nil {
		return err
	}

	throttleReviewers(reviewRegistry, cfg.Review.MaxConcurrentLLM)

	// `cfg.Resolver.Default` selects which provider entry to instantiate —
	// usually a Haiku-class model on OpenRouter for short-form match decisions.
	resCfg, ok := cfg.Resolver.Providers[cfg.Resolver.Default]
	if !ok {
		return fmt.Errorf("resolver: default %q not in providers map", cfg.Resolver.Default)
	}
	resolverChain, err := buildResolverChain(cfg.Resolver.Default, resCfg, currentDBPath)
	if err != nil {
		return err
	}

	translator, err := buildDictTranslator(resCfg)
	if err != nil {
		return err
	}

	// Used by tracks_titles_refresh; one-line response per track.
	titleExtractor, err := buildTitleExtractor(resCfg)
	if err != nil {
		return err
	}

	outlineGen, err := buildOutlineGenerator(cfg.Outline)
	if err != nil {
		return err
	}
	outlineCompress, err := resolveOutlineCompressor(cfg.Outline.Compress)
	if err != nil {
		return err
	}
	outlineBatcher, err := buildOutlineBatcher(cfg.Outline.Batch)
	if err != nil {
		return err
	}

	// FuzzyIndex prefilters dict candidates for the LLM resolver via
	// trigram-overlap matching against the live catalog. Replaces the
	// old dict_resolution_cache (which persistently mapped query → id
	// in lake/index.db and was a perpetual source of drift between
	// the catalog and the lake on manual edits). The fuzzy index is
	// pure derived state from current.db and rebuilds itself when
	// dictcrud mutations land or when an explicit Rebuild is called.
	fuzzyIndex := sqlitecatalog.NewFuzzyIndex(sqlitecatalog.NewLazy(currentDBPath))

	// Shared dict CRUD use case — used by the generic dict tools and reused by
	// the topic build (to mint topic_<nanoid> entries while naming clusters).
	dictCRUDUC := dictcrud.UseCase{
		Catalog:    sqlitecatalog.NewLazy(currentDBPath),
		FuzzyIndex: fuzzyIndex,
		Minter:     minter,
	}

	// The granular outline artifacts and the centroid vocabulary share artifactWriter.
	outlineArtifacts := fsoutline.New(artifactWriter)
	topicCentroids := fstopics.New(artifactWriter)
	topicsDeps := buildTopicsDeps(cfg, outlineArtifacts, topicCentroids, dictCRUDUC, currentDBPath)

	// Generic helpers used by ingest (sha256 of source) and commit (file
	// existence checks). Defined here so the application layer never
	// touches os.* directly.
	osfs := osfs.New()
	hasher := sha256hash.New()
	id3Tagger := id3v2tagger.New()

	// AudioTag is invoked at the end of commit so the public mp3 picks up
	// ID3 metadata reflecting the just-committed catalog state, and is also
	// exposed standalone via track_tag_audio for re-tagging after manual
	// metadata edits.
	audioTagUC := audiotag.UseCase{
		Catalog: sqlitecatalog.NewLazy(currentDBPath),
		Audio:   audioStore,
		Tagger:  id3Tagger,
	}

	// commitUC is referenced as the Rollbacker by ingest (so SHA-changed
	// re-ingest can purge stale catalog rows before the cascade) and by
	// runpipeline (Force=true). Build it once up front.
	commitUC := commit.UseCase{
		Registry:    registry,
		Audio:       audioStore,
		Transcripts: transcriptStore,
		Catalog:     sqlitecatalog.NewLazy(currentDBPath),
		FS:          osfs,
		OutDir:      cfg.Out,
		AudioTag:    &audioTagUC,
		OpMutex:     catalogOpMutex,
	}

	// alignPDFUC is built up front so review can reference it as a pointer
	// for its early-branch fork. When the aligner sidecar isn't configured
	// (cfg.Review.AlignPDF.ScriptPath empty), Aligner stays nil and review
	// won't take the PDF branch — it just runs the LLM path as before.
	alignPDFUC := alignpdfuc.UseCase{
		Registry:    registry,
		Transcripts: transcriptStore,
		Aligner:     alignerOrNil(pdfAligner),
		OutDir:      cfg.Out,
		Clock:       sysClock,
	}

	assetUploader, err := buildAssetUploader(ctx, cfg.S3, bunnyTarget)
	if err != nil {
		return err
	}

	coverGen, topicCoverGen, err := buildCoverGenerators(cfg.Images, assetUploader, currentDBPath)
	if err != nil {
		return err
	}
	topicsDeps.Cover = topicCoverGen
	// Batch cover generation over all topics (async fan-out). Gated at call time
	// on the generator being enabled; the lister works regardless.
	topicsDeps.CoverBuild = topicsapp.CoverBuildUseCase{
		Lister: sqlitecatalog.NewLazy(currentDBPath),
		Cover:  topicCoverGen,
	}

	// Author avatar/bio (avatar upload disabled when no S3 bucket; bio set
	// works regardless since it only writes the catalog DB).
	authorProfile := authorprofile.UseCase{
		Catalog:  sqlitecatalog.NewLazy(currentDBPath),
		Uploader: assetUploader,
	}

	// Config registry: the extensible catalog of settings keys the
	// config.* tools can read/write. Validators check referential integrity
	// against the catalog (e.g. onboarding.topics ids must exist).
	configTopicLazy := sqlitecatalog.NewLazy(currentDBPath)
	configRegistry := configregistry.New(configregistry.ValidateDeps{
		TopicExists: func(ctx context.Context, id string) (bool, error) {
			_, ok, err := configTopicLazy.GetDict(ctx, catalog.KindTopic, id)
			return ok, err
		},
	})
	if err := configRegistry.Register(configregistry.OnboardingTopicsDescriptor()); err != nil {
		return fmt.Errorf("register descriptor: %w", err)
	}

	deps := tools.Deps{
		Registry:        registry,
		Transcripts:     transcriptStore,
		ReviewBatchJobs: reviewBatchJobs,
		Ingest: ingest.UseCase{
			Registry:   registry,
			Audio:      audioStore,
			FS:         osfs,
			Hasher:     hasher,
			Rollbacker: commitUC,
			Meta:       extractor,
			Clock:      sysClock,
		},
		Normalize: normalize.UseCase{
			Registry:   registry,
			Audio:      audioStore,
			Normalizer: ffTool,
		},
		AudioDenoise: audiodenoise.UseCase{
			Audio:       audioStore,
			Probe:       ffTool,
			Denoiser:    execdenoise.New(cfg.Denoiser.PythonBin, cfg.Denoiser.Script),
			Catalog:     sqlitecatalog.NewLazy(currentDBPath),
			Transcripts: transcriptStore,
		},
		RegisterAudio: registeraudio.UseCase{
			Catalog: sqlitecatalog.NewLazy(currentDBPath),
		},
		Catalog: tools.CatalogDeps{
			Refresh: catalogrefresh.UseCase{
				OutDir:          cfg.Out,
				SupportedScheme: catalog.SupportedDBScheme,
				CDN:             cdnSrc,
				SchemeReader:    sqlitecatalog.NewSchemeReader(),
				OpMutex:         catalogOpMutex,
				Clock:           sysClock,
			},
			OpenRepo: func(ctx context.Context) (tools.CatalogRepo, error) {
				if _, err := os.Stat(currentDBPath); err != nil {
					return nil, fmt.Errorf("catalog not refreshed yet — run catalog_refresh first (%w)", err)
				}
				return sqlitecatalog.Open(ctx, currentDBPath)
			},
		},
		ConfigStore: tools.ConfigDeps{
			Settings: sqlitecatalog.NewLazy(currentDBPath),
			Registry: configRegistry,
		},
		Wisdom: tools.WisdomDeps{
			Catalog: sqlitecatalog.NewLazy(currentDBPath),
			Minter:  minter,
		},
		Metadata: extractmeta.UseCase{
			Registry:        registry,
			Audio:           audioStore,
			Probe:           ffTool,
			Extractor:       extractor,
			Catalog:         sqlitecatalog.NewLazy(currentDBPath),
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
			Catalog:     sqlitecatalog.NewLazy(currentDBPath),
			Granular:    outlineArtifacts,
			Compress:    outlineCompress,
			Batch:       outlineBatcher,
			BatchJobs:   outlineuc.NewBatchStore(cfg.Out),
			MaxTokens:   cfg.Outline.MaxTokens,
			Clock:       sysClock,
		},
		RefreshTitle: titleuc.UseCase{
			Registry:    registry,
			Transcripts: transcriptStore,
			Aligner:     alignerOrNil(pdfAligner),
			LLM:         titleExtractor,
			SetTrackMetadata: commit.SetTrackMetadataUseCase{
				Registry: registry,
				Catalog:  sqlitecatalog.NewLazy(currentDBPath),
			},
			OutDir: cfg.Out,
		},
		Review: reviewuc.UseCase{
			Registry:    registry,
			Transcripts: transcriptStore,
			Reviewers:   reviewRegistry,
			Splitter:    splitterOrNil(sentenceSplitter),
			Align:       alignPDFOrNil(pdfAligner, &alignPDFUC),
			OutDir:      cfg.Out,
			DefaultAttemptsFor: func(language string) []reviewuc.Attempt {
				src := cfg.Review.DefaultReviewAttempts(language)
				out := make([]reviewuc.Attempt, len(src))
				for i, a := range src {
					out[i] = reviewuc.Attempt{
						Models:          a.Models,
						Threshold:       a.Threshold,
						Expand:          a.Expand,
						PremiumMinChars: a.PremiumMinChars,
					}
				}
				return out
			},
			ChunkSize:            cfg.Review.ChunkSize,
			Overlap:              cfg.Review.Overlap,
			Retries:              cfg.Review.Retries,
			Concurrency:          cfg.Review.Concurrency,
			LowConfThreshold:     cfg.Review.Hybrid.Threshold,
			NoiseFilterThreshold: cfg.Review.NoiseFilterThreshold,
			Glossary:             glossaryOrNil(reviewGlossary),
			Batch:                reviewBatcher,
			BatchJobs:            reviewBatchJobs,
			BatchModel:           cfg.Review.Batch.Model,
			BatchMaxTokens:       cfg.Review.Batch.MaxTokens,
			BatchPriceIn:         cfg.Review.Batch.InputPerMillion,
			BatchPriceOut:        cfg.Review.Batch.OutputPerMillion,
			GlossaryThreshold:    cfg.Review.Glossary.MatchThreshold,
			GlossaryMaxHints:     cfg.Review.Glossary.MaxHintsPerChunk,
			Clock:                sysClock,
		},
		Commit:   commitUC,
		AudioTag: audioTagUC,
		SetTrackMetadata: commit.SetTrackMetadataUseCase{
			Registry: registry,
			Catalog:  sqlitecatalog.NewLazy(currentDBPath),
		},
		SelectTracks: selectTracksUC,
		Runs:         runRegistry,
		Runner:       runRunner,
		DictCRUD: tools.DictCRUDDeps{
			UseCase: dictCRUDUC,
		},
		Topics: topicsDeps,
		CollectionCRUD: tools.CollectionCRUDDeps{
			UseCase: collectioncrud.UseCase{
				Catalog: sqlitecatalog.NewLazy(currentDBPath),
				Minter:  minter,
			},
			Cover: coverGen,
		},
		CollectionGroupCRUD: tools.CollectionGroupCRUDDeps{
			UseCase: collectiongroupcrud.UseCase{
				Catalog: sqlitecatalog.NewLazy(currentDBPath),
				Minter:  minter,
			},
		},
		AuthorProfile: tools.AuthorProfileDeps{UseCase: authorProfile},
		Find: tools.FindDeps{
			Catalog:  sqlitecatalog.NewLazy(currentDBPath),
			Resolver: resolverChain,
			TopN:     cfg.Resolver.CandidatesTopN,
		},
		InDir:  cfg.In,
		OutDir: cfg.Out,
		Config: cfg,
		AdminConfig: adminconfigapp.Service{
			Endpoints: adminruntime,
			Defaults:  adminruntime,
			Snap:      adminruntime,
		},
	}

	// Pipeline orchestrator references the same use cases as the deps.
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

	// Worker pool drains the queue and runs deps.Pipeline for each item.
	pool := worker.New(deps.Pipeline, *workers, 0)
	deps.Pool = pool

	deps.Publish = catalogpublish.UseCase{
		OutDir:          cfg.Out,
		SupportedScheme: catalog.SupportedDBScheme,
		Targets:         publishTargets,
		OpMutex:         catalogOpMutex,
		Clock:           sysClock,
	}
	deps.AssetSync = tools.AssetSyncDeps{
		UseCase: assetsync.UseCase{OutDir: cfg.Out, Targets: publishTargets, Registry: registry},
	}
	libraryLazy := sqlitelibrary.NewLazy(libraryDBPath)
	deps.Library = tools.LibraryDeps{
		Repo: libraryLazy,
	}

	// Best-effort auto-translate of one source text into the other supported
	// langs on library.attribution.create; failures are non-fatal in the use case.
	attribTranslator, err := buildAttributionTranslator(resCfg)
	if err != nil {
		return err
	}
	deps.LibraryAttribution = tools.LibraryAttributionDeps{
		UseCase: attributionapp.UseCase{
			Repo:       libraryLazy,
			Translator: attribTranslator,
			Minter:     minter,
			Langs:      []string{"ru", "en"},
		},
		Library: libraryLazy,
	}
	deps.LibraryImport = tools.LibraryImportDeps{
		UseCase: librarymedia.UseCase{
			Repo:    libraryLazy,
			Targets: publishTargets, // reuse the publish path's S3 uploaders (AWS primary)
			Minter:  minter,
		},
	}
	deps.LibraryPublish = tools.LibraryPublishDeps{
		UseCase: librarypublish.UseCase{
			OutDir:  cfg.Out,
			Targets: publishTargets,
			OpMutex: catalogOpMutex, // share with catalog: never two concurrent publishes
			Clock:   sysClock,
		},
	}

	// Corpus-promotion queue (issues #1232/#1233): self-fetch pending.db from the
	// CDN, read it, and gate approvals into the corpus (zero-copy). The corpus
	// write reuses the same catalog CommitRepository that track.commit uses.
	pendingLazy := sqlitepending.NewLazy(pendingDBPath)
	deps.Pending = tools.PendingDeps{
		Refresh: pendingrefresh.UseCase{
			OutDir:   cfg.Out,
			CDN:      cdnSrc,
			Verifier: sqlitepending.NewVerifier(),
			OpMutex:  &sync.Mutex{}, // serialize refresh vs. approve's mark-consumed
		},
		Reader: pendingLazy,
		Approve: promote.UseCase{
			Pending: pendingLazy,
			Catalog: sqlitecatalog.NewLazy(currentDBPath),
		},
	}
	deps.Proactive = tools.ProactiveDeps{
		UseCase: catalogproactive.UseCase{
			OutDir: cfg.Out,
			Mu:     catalogOpMutex,
		},
	}
	deps.Regions = tools.RegionsDeps{
		UseCase: catalogregions.UseCase{
			OutDir: cfg.Out,
			Mu:     catalogOpMutex, // share with proactive + publishers (one config.json writer at a time)
		},
	}
	deps.ConfigPublish = tools.ConfigPublishDeps{
		UseCase: configpublish.UseCase{
			OutDir:  cfg.Out,
			Targets: publishTargets,
			OpMutex: catalogOpMutex,
		},
	}

	// Auto-refresh on first start if current.db is missing.
	if _, err := os.Stat(currentDBPath); err != nil {
		fmt.Fprintln(os.Stderr, "[catalog] current.db missing — auto-refresh from CDN")
		res, err := deps.Catalog.Refresh.Run(ctx, false)
		if err != nil {
			fmt.Fprintf(os.Stderr, "[catalog] auto-refresh failed: %v (continuing; call catalog_refresh manually)\n", err)
		} else {
			fmt.Fprintf(os.Stderr, "[catalog] downloaded version=%d scheme=%d\n", res.Version, res.Scheme)
		}
	}

	httpServer := buildMCPHTTPServer(deps, *addr, *heartbeat)

	// Start the worker pool. Cancelled on shutdown — workers drop in-flight
	// items at next stage boundary; partial state survives in `stages` and is
	// resumed on the next ingest of the same path (idempotent stage skip).
	poolCtx, poolCancel := context.WithCancel(context.Background())
	defer poolCancel()
	pool.Start(poolCtx)

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		log.Printf("shutdown: stopping HTTP server + pool")
		shutdownCtx, c := context.WithTimeout(context.Background(), 10*time.Second)
		defer c()
		_ = httpServer.Shutdown(shutdownCtx)
		poolCancel()
	}()

	log.Printf("lectorium-mcp listening on %s (workers=%d, transcribe-concurrency=%d, streamable=%s, sse=%s)",
		*addr, *workers, *transcribeConcurrency, streamableHTTPPath, ssePath)
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return fmt.Errorf("listen: %w", err)
	}
	log.Printf("lectorium-mcp stopped cleanly")
	return nil
}

func printConfig(path string, cfg *config.Config) {
	fmt.Printf("lectorium-mcp\n")
	fmt.Printf("  config:           %s\n", path)
	fmt.Printf("  scheme:           %d\n", catalog.SupportedDBScheme)
	fmt.Printf("  in:               %s\n", cfg.In)
	fmt.Printf("  out:              %s\n", cfg.Out)
	fmt.Printf("  db:               %s\n", cfg.DB)
	fmt.Printf("  default_language: %s\n", cfg.DefaultLanguage)
	fmt.Printf("  cdn.read_base_url:%s\n", cfg.CDN.ReadBaseURL)
	fmt.Printf("  s3.aws.bucket:    %s (region=%s)\n", cfg.S3.AWS.Bucket, cfg.S3.AWS.Region)
	if cfg.S3.Yandex.Bucket != "" {
		fmt.Printf("  s3.yandex.bucket: %s (region=%s, endpoint=%s)\n",
			cfg.S3.Yandex.Bucket, cfg.S3.Yandex.Region, cfg.S3.Yandex.Endpoint)
	}
	fmt.Printf("  ffmpeg:           bin=%s\n", cfg.FFmpeg.Bin)
	fmt.Printf("  transcribe.default: %s\n", cfg.Transcribe.Default)
	for name, p := range cfg.Transcribe.Providers {
		fmt.Printf("  transcribe[%s]: kind=%s endpoint=%s model=%s\n", name, p.Kind, p.Endpoint, p.Model)
	}
	fmt.Printf("  review:           defaults=%v (chunk=%d overlap=%d retries=%d concurrency=%d hybrid={threshold=%.2f expand=%d})\n",
		cfg.Review.Default, cfg.Review.ChunkSize, cfg.Review.Overlap, cfg.Review.Retries, cfg.Review.Concurrency, cfg.Review.Hybrid.Threshold, cfg.Review.Hybrid.Expand)
	for alias, p := range cfg.Review.Providers {
		fmt.Printf("  review[%s]: model=%s endpoint=%s reasoning=%s api_key=%s\n", alias, p.Model, p.Endpoint, p.Reasoning, maskKey(p.APIKey))
	}
	fmt.Printf("  resolver.default: %s (top_n=%d)\n",
		cfg.Resolver.Default, cfg.Resolver.CandidatesTopN)
	for alias, p := range cfg.Resolver.Providers {
		fmt.Printf("  resolver[%s]: model=%s endpoint=%s api_key=%s\n", alias, p.Model, p.Endpoint, maskKey(p.APIKey))
	}
	fmt.Printf("  metadata:         model=%s endpoint=%s api_key=%s (max_tokens=%d)\n",
		cfg.Metadata.Model, cfg.Metadata.Endpoint, maskKey(cfg.Metadata.APIKey), cfg.Metadata.MaxTokens)
}

func maskKey(k string) string {
	if k == "" {
		return "<unset>"
	}
	if len(k) <= 8 {
		return "***"
	}
	return k[:4] + "…" + k[len(k)-4:]
}

// splitterOrNil returns a sentencesplit.Splitter typed value or nil.
// The straightforward `Splitter: sentenceSplitter` would fail Go's
// nil-interface trap when the concrete is nil but the interface
// header isn't, leading to a non-nil Splitter that panics on first
// call. Routing through this helper keeps the use case's nil check
// honest.
func splitterOrNil(s *razdelsplit.Splitter) sentencesplit.Splitter {
	if s == nil {
		return nil
	}
	return s
}

// alignPDFOrNil returns the alignpdf use case as a pointer when the aligner
// sidecar successfully spawned, or nil when it didn't. Review's early-branch
// check is `if uc.AlignPDF != nil`, so nil here means the LLM path always wins.
func alignPDFOrNil(a *pythonalign.Aligner, uc *alignpdfuc.UseCase) *alignpdfuc.UseCase {
	if a == nil {
		return nil
	}
	return uc
}

// alignerOrNil dodges the same nil-interface trap as splitterOrNil — pass
// nil through as a true nil interface, not a typed-nil whose method-set
// would panic on first call.
func alignerOrNil(a *pythonalign.Aligner) alignport.Aligner {
	if a == nil {
		return nil
	}
	return a
}

// glossaryOrNil dodges the typed-nil interface trap for the glossary
// matcher port. loadGlossaryOrNil may return a nil *glossary.Glossary;
// passing that directly into the interface field would yield a non-nil
// interface holding a nil concrete (the classic Go gotcha), so review's
// `if uc.Glossary != nil` check would fire and call into a nil receiver.
func glossaryOrNil(g *glossary.Glossary) glossaryport.Matcher {
	if g == nil {
		return nil
	}
	return g
}

// loadGlossaryOrNil returns the review glossary. `override`, when set, is an
// operator YAML file taken verbatim; otherwise the curated dictionary embedded
// in the shared glossary package is used. Returns nil only when even the
// embedded data fails to parse — the use case runs unchanged without it.
func loadGlossaryOrNil(override string) *glossary.Glossary {
	if override != "" {
		if body, err := os.ReadFile(override); err == nil {
			if g, err := glossary.Parse(body); err == nil {
				fmt.Fprintf(os.Stderr, "[review] glossary loaded: %d entries from %s\n", len(g.Entries), override)
				return g
			} else {
				fmt.Fprintf(os.Stderr, "[review] glossary override parse failed, using embedded: %v\n", err)
			}
		} else {
			fmt.Fprintf(os.Stderr, "[review] glossary override unreadable, using embedded: %v\n", err)
		}
	}
	g, err := glossary.Embedded()
	if err != nil {
		fmt.Fprintf(os.Stderr, "[review] glossary disabled: %v\n", err)
		return nil
	}
	fmt.Fprintf(os.Stderr, "[review] glossary loaded: %d embedded entries\n", len(g.Entries))
	return g
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

// resolveConfigPath looks for the YAML config in the current working
// directory (project-local). The home directory is intentionally NOT
// consulted — the config (and any .env it depends on) belong with the
// project, not under $HOME.
func resolveConfigPath(explicit string) (string, error) {
	candidates := []string{}
	if explicit != "" {
		candidates = append(candidates, explicit)
	} else {
		candidates = append(candidates, "lectorium-mcp.yaml", "lectorium-mcp.yml")
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			abs, _ := filepath.Abs(c)
			return abs, nil
		}
	}
	return "", fmt.Errorf("no config found; tried: %v", candidates)
}
