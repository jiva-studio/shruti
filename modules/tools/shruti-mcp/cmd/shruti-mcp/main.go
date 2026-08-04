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
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/mark3labs/mcp-go/server"

	adminconfigapp "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/adminconfig"
	alignpdfuc "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/alignpdf"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/assetsync"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/audiodenoise"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/audiotag"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/authorprofile"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/collectioncover"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/collectioncrud"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/collectiongroupcrud"
	configpublish "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/configpublish"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/covergen"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/dictcrud"
	catalogproactive "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/proactive"
	catalogpublish "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/publish"
	catalogrefresh "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/refresh"
	catalogregions "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/regions"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/topiccover"
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
	reviewuc "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/review"
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
	pythonalign "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/alignpdf/python"
	fsartifact "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/artifact/fs"
	openaicompatattribtranslate "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/attributiontranslate/openaicompat"
	fsaudio "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/audiostore/fs"
	resolverchain "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/catalog/resolver/chain"
	exactresolver "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/catalog/resolver/exact"
	openaicompatresolver "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/catalog/resolver/openaicompat"
	sqlitecatalog "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/catalog/sqlite"
	httpcdn "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/cdn/http"
	execdenoise "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/denoise/exec"
	openaicompattranslate "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/dicttranslate/openaicompat"
	openaicompatembed "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/embed/openaicompat"
	osfs "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/fs/os"
	sha256hash "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/hashing/sha256"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/ids/nanoid"
	openrouterimage "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/imagegen/openrouter"
	sqliteregistry "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/lakeregistry/sqlite"
	sqlitelibrary "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/library/sqlite"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/loudness/ffmpeg"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/metadata/canonical"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/metadata/filemeta"
	openaicompatmeta "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/metadata/openaicompat"
	fsoutline "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/outline/fs"
	sqlitepending "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/pending/sqlite"
	reviewreg "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/review"
	throttledreview "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/review/throttled"
	sqliteruns "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/runregistry/sqlite"
	awss3 "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/s3/aws"
	bunnys3 "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/s3/bunny"
	razdelsplit "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/sentencesplit/razdel"
	id3v2tagger "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/tagger/id3v2"
	openaicompattitle "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/title/openaicompat"
	fstopics "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/topics/fs"
	openaicompattopics "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/topics/openaicompat"
	transcribereg "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/transcribe"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/transcribe/transcriberservice"
	fstranscript "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/infra/transcriptstore/fs"
	mcpsrv "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/mcp"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/mcp/tools"
	alignpdfport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/alignpdf"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/dicttranslate"
	s3port "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/s3"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/worker"
	glossary "github.com/jiva-studio/shruti/pipeline/glossary"
	openaicompatoutline "github.com/jiva-studio/shruti/pipeline/outline/openaicompat"
	glossaryport "github.com/jiva-studio/shruti/pipeline/ports/glossary"
	outlineport "github.com/jiva-studio/shruti/pipeline/ports/outline"
	"github.com/jiva-studio/shruti/pipeline/ports/sentencesplit"
	openaicompatreview "github.com/jiva-studio/shruti/pipeline/review/openaicompat"
	"github.com/jiva-studio/shruti/pipeline/transcriber/deepgram"
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
	type rec struct{ trackID, lang, path string }
	var recs []rec
	for rows.Next() {
		var r rec
		if err := rows.Scan(&r.trackID, &r.lang, &r.path); err != nil {
			rows.Close()
			return err
		}
		recs = append(recs, r)
	}
	rows.Close()
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
	configPath := flag.String("config", "", "path to YAML config (default: ./shruti-mcp.yaml or ~/.config/shruti-mcp/config.yaml)")
	doServe := flag.Bool("serve", true, "run the MCP HTTP server (default true)")
	addr := flag.String("addr", "127.0.0.1:8081", "HTTP listen address for MCP transports (streamable + SSE)")
	heartbeat := flag.Duration("heartbeat-interval", 15*time.Second, "MCP keepalive heartbeat for streamable HTTP / SSE")
	workers := flag.Int("workers", 4, "number of file-level pipeline workers")
	transcribeConcurrency := flag.Int("transcribe-concurrency", 2, "max concurrent transcribe calls (matches M-box worker count)")
	backfillHashes := flag.Bool("backfill-asset-hashes", false, "scan published transcripts under <out> and (re)populate asset_hashes in current.db, then exit")
	flag.Parse()

	path, err := resolveConfigPath(*configPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	cfg, err := config.Load(path)
	if err != nil {
		log.Fatalf("config load: %v", err)
	}

	if *backfillHashes {
		if err := runBackfillAssetHashes(cfg.Out); err != nil {
			log.Fatalf("backfill-asset-hashes: %v", err)
		}
		return
	}

	if !*doServe {
		printConfig(path, cfg)
		return
	}

	ctx := context.Background()

	// Make sure output tree skeleton exists.
	mustMkdirAll(filepath.Join(cfg.Out, "public", "tracks"))
	mustMkdirAll(filepath.Join(cfg.Out, "artifacts", "tracks"))
	mustMkdirAll(filepath.Join(cfg.Out, "artifacts", "lake"))
	mustMkdirAll(filepath.Join(cfg.Out, "artifacts", "catalog"))

	// Adapters.
	minter := nanoid.New()
	registry, err := sqliteregistry.New(ctx, cfg.DB, minter)
	if err != nil {
		log.Fatalf("open lake registry: %v", err)
	}
	defer registry.Close()

	if n, err := registry.MarkInterruptedAsFailed(ctx); err != nil {
		log.Fatalf("recovery: %v", err)
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

	// LLM extractor for metadata. Uses the shared openai-compat client
	// pointed at OpenRouter (or any compatible upstream) — same model
	// naming convention as the review providers (e.g. anthropic/claude-sonnet-4.6).
	llmExtractor, err := openaicompatmeta.New(openaicompatmeta.Config{
		Endpoint:   cfg.Metadata.Endpoint,
		APIKey:     cfg.Metadata.APIKey,
		Model:      cfg.Metadata.Model,
		MaxTokens:  cfg.Metadata.MaxTokens,
		PromptPath: cfg.Metadata.PromptPath,
	})
	if err != nil {
		log.Fatalf("metadata extractor: %v", err)
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

	// S3 targets for publish + immediate artifact upload. AWS is required
	// (read+write); Yandex is mirror. Built up front so artifact stores (which
	// write+upload private artifacts as they're produced) share the same
	// uploaders as the publish path.
	var publishTargets []s3port.Uploader
	if cfg.S3.AWS.Bucket != "" {
		aws, err := awss3.New(ctx, awss3.Target{
			Name:            "aws",
			Bucket:          cfg.S3.AWS.Bucket,
			Region:          cfg.S3.AWS.Region,
			Endpoint:        cfg.S3.AWS.Endpoint,
			AccessKeyID:     cfg.S3.AWS.AccessKeyID,
			SecretAccessKey: cfg.S3.AWS.SecretAccessKey,
			ForcePathStyle:  cfg.S3.AWS.ForcePathStyle,
		})
		if err != nil {
			fmt.Fprintf(os.Stderr, "[s3:aws] init failed (catalog_publish will error): %v\n", err)
		} else {
			publishTargets = append(publishTargets, aws)
		}
	}
	if cfg.S3.Yandex.Bucket != "" {
		ya, err := awss3.New(ctx, awss3.Target{
			Name:            "yandex",
			Bucket:          cfg.S3.Yandex.Bucket,
			Region:          cfg.S3.Yandex.Region,
			Endpoint:        cfg.S3.Yandex.Endpoint,
			AccessKeyID:     cfg.S3.Yandex.AccessKeyID,
			SecretAccessKey: cfg.S3.Yandex.SecretAccessKey,
			ForcePathStyle:  cfg.S3.Yandex.ForcePathStyle,
		})
		if err != nil {
			fmt.Fprintf(os.Stderr, "[s3:yandex] init failed: %v\n", err)
		} else {
			publishTargets = append(publishTargets, ya)
		}
	}
	if cfg.S3.Bunny.Zone != "" {
		bny, err := bunnys3.New(bunnys3.Target{
			Name:      "bunny",
			Zone:      cfg.S3.Bunny.Zone,
			Endpoint:  cfg.S3.Bunny.Endpoint,
			AccessKey: cfg.S3.Bunny.AccessKey,
		})
		if err != nil {
			fmt.Fprintf(os.Stderr, "[s3:bunny] init failed: %v\n", err)
		} else {
			publishTargets = append(publishTargets, bny)
		}
	}

	// One artifact writer for all private per-track textual artifacts: writes
	// the lake copy AND uploads to the S3 targets above under the artifacts/
	// prefix, in one call. Lake-only when no bucket is configured.
	artifactWriter := fsartifact.New(cfg.Out, publishTargets...)

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
		log.Fatalf("open runs.db: %v", err)
	}
	defer runRegistry.Close()
	runRunner := runner.New(runRegistry)

	// Transcribe providers — registry mirrors the review/resolver pattern so
	// adding (e.g.) an OpenAI Whisper API adapter later only adds a Kind-
	// dispatch branch here, not new wiring through the application layer.
	transcribeRegistry := transcribereg.New()
	for name, p := range cfg.Transcribe.Providers {
		switch p.Kind {
		case "transcriber-service":
			t := transcriberservice.New(transcriberservice.Config{
				Endpoint: p.Endpoint,
				Cleanup:  true,
			})
			transcribeRegistry.Register(worker.NewThrottledTranscriber(t, *transcribeConcurrency))
		case "deepgram":
			if p.APIKey == "" {
				log.Fatalf("transcribe provider %q: deepgram needs api_key", name)
			}
			t := deepgram.New(deepgram.Config{
				APIKey:   p.APIKey,
				Model:    p.Model,
				Language: p.Language,
				Diarize:  p.Diarize,
			})
			transcribeRegistry.Register(worker.NewThrottledTranscriber(t, *transcribeConcurrency))
		default:
			log.Fatalf("transcribe provider %q: unknown kind %q", name, p.Kind)
		}
	}
	transcribeRegistry.SetDefault(cfg.Transcribe.Default)

	// Admin-config runtime adapter: implements the EndpointMutator,
	// DefaultMutator, and SnapshotProvider ports by reaching into the
	// transcriber registry. Wired into tools.Deps.AdminConfig below.
	adminruntime := &adminconfigrt.Adapter{
		Transcribers: transcribeRegistry,
		Config:       cfg,
	}

	// Sentencer (razdel subprocess). Optional: when ScriptPath isn't
	// configured, the review usecase falls back to LLM-derived sentence
	// boundaries. Construction failure is non-fatal so a missing
	// `pip install razdel` doesn't take the whole daemon down.
	var sentenceSplitter *razdelsplit.Splitter
	if cfg.Review.Sentencer.ScriptPath != "" {
		s, err := razdelsplit.New(razdelsplit.Config{
			PythonBin:  cfg.Review.Sentencer.PythonBin,
			ScriptPath: cfg.Review.Sentencer.ScriptPath,
		})
		if err != nil {
			fmt.Fprintf(os.Stderr, "[sentencer] disabled: %v\n", err)
		} else {
			sentenceSplitter = s
			defer sentenceSplitter.Close()
		}
	}

	// PDF aligner (scripts/pdf_align/daemon.py subprocess). Optional: when ScriptPath
	// isn't configured, the review usecase always falls through to the LLM
	// path even if a transcript.pdf is present. Construction failure is
	// non-fatal — a missing pymupdf shouldn't take the whole daemon down.
	var pdfAligner *pythonalign.Aligner
	if cfg.Review.AlignPDF.ScriptPath != "" {
		a, err := pythonalign.New(pythonalign.Config{
			PythonBin:  cfg.Review.AlignPDF.PythonBin,
			ScriptPath: cfg.Review.AlignPDF.ScriptPath,
		})
		if err != nil {
			fmt.Fprintf(os.Stderr, "[align_pdf] disabled: %v\n", err)
		} else {
			pdfAligner = a
			defer pdfAligner.Close()
		}
	}

	// Review reviewers: every entry in cfg.Review.Providers is one
	// OpenAI-compatible upstream (OpenRouter, native OpenAI, vLLM, etc.).
	// Hybrid is constructed at call-time by the registry when caller
	// passes 2 model aliases; not registered as a separate provider.
	reviewRegistry := reviewreg.New(cfg.Review.Hybrid.Threshold, cfg.Review.Hybrid.Expand, cfg.Review.Hybrid.PremiumMinChars)
	for alias, p := range cfg.Review.Providers {
		if p.APIKey == "" {
			fmt.Fprintf(os.Stderr, "[review] provider %q skipped: api_key is empty\n", alias)
			continue
		}
		reviewer, err := openaicompatreview.New(openaicompatreview.Config{
			NameAlias: alias,
			Endpoint:  p.Endpoint,
			APIKey:    p.APIKey,
			Model:     p.Model,
			MaxTokens: p.MaxTokens,
			Reasoning: p.Reasoning,
			Format:    openaicompatreview.Format(p.Format),
		})
		if err != nil {
			log.Fatalf("review provider %q: %v", alias, err)
		}
		reviewRegistry.Register(reviewer)
	}

	// Glossary: Vaishnava-terminology dictionary for RAG-style per-chunk
	// hint injection + canonical safety net. By default we look for
	// `glossary.yaml` next to the binary (deployment ships
	// them as a pair); operators can override via review.glossary.path.
	// Missing file keeps the feature dormant — no spammy errors.
	reviewGlossary := loadGlossaryOrNil(cfg.Review.Glossary.Path)

	// Wrap every registered reviewer in a global throttle. The cap applies
	// across all worker-pool slots and all per-track review.concurrency
	// fan-out — preventing 429s when a batch run pushes through hundreds
	// of chunks back-to-back. The wrapper preserves Name() so the registry
	// map stays consistent (Register overwrites by name).
	if maxLLM := cfg.Review.MaxConcurrentLLM; maxLLM > 0 {
		for _, name := range reviewRegistry.List() {
			inner, ok := reviewRegistry.Get(name)
			if !ok {
				continue
			}
			reviewRegistry.Register(throttledreview.New(inner, maxLLM))
		}
	}

	// Resolver chain: exact (cheap) → openai-compat (LLM). Catalog opens lazily.
	// `cfg.Resolver.Default` selects which provider entry to instantiate —
	// usually a Haiku-class model on OpenRouter for short-form match decisions.
	resCfg, ok := cfg.Resolver.Providers[cfg.Resolver.Default]
	if !ok {
		log.Fatalf("resolver: default %q not in providers map", cfg.Resolver.Default)
	}
	llmResolver, err := openaicompatresolver.New(openaicompatresolver.Config{
		NameAlias:  cfg.Resolver.Default,
		Endpoint:   resCfg.Endpoint,
		APIKey:     resCfg.APIKey,
		Model:      resCfg.Model,
		MaxTokens:  resCfg.MaxTokens,
		PromptPath: resCfg.PromptPath,
	})
	if err != nil {
		log.Fatalf("llm resolver: %v", err)
	}
	resolverChain := resolverchain.New(
		exactresolver.NewLazy(currentDBPath),
		llmResolver,
	)

	// Translator reuses the resolver model (Haiku-class is plenty for
	// short-form transliteration of new dict entries).
	var translator dicttranslate.Translator
	t, err := openaicompattranslate.New(openaicompattranslate.Config{
		Endpoint:  resCfg.Endpoint,
		APIKey:    resCfg.APIKey,
		Model:     resCfg.Model,
		MaxTokens: 256,
	})
	if err != nil {
		log.Fatalf("dict translator: %v", err)
	}
	translator = t

	// Title extractor (used by tracks_titles_refresh) — also reuses the
	// resolver Haiku provider; one-line response per track.
	titleExtractor, err := openaicompattitle.New(openaicompattitle.Config{
		Endpoint:  resCfg.Endpoint,
		APIKey:    resCfg.APIKey,
		Model:     resCfg.Model,
		MaxTokens: 64,
	})
	if err != nil {
		log.Fatalf("title extractor: %v", err)
	}

	// Outline generator (track.transcript.outline / pipeline.run op=outline) —
	// Gemini via OpenRouter; disabled (nil) when cfg.Outline.APIKey is empty.
	var outlineGen outlineport.Generator
	if cfg.Outline.APIKey != "" {
		g, err := openaicompatoutline.New(openaicompatoutline.Config{
			Endpoint:  cfg.Outline.Endpoint,
			APIKey:    cfg.Outline.APIKey,
			Model:     cfg.Outline.Model,
			MaxTokens: cfg.Outline.MaxTokens,
			Reasoning: cfg.Outline.Reasoning,
		})
		if err != nil {
			log.Fatalf("outline generator: %v", err)
		}
		outlineGen = g
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

	// Topic recommender (topics.build / track.topics.assign / pipeline.run
	// op=topics): a text-embeddings client + an LLM cluster namer. Both gated on
	// cfg.Embed.APIKey (and the outline LLM config, reused for naming). The
	// granular outline artifacts and the centroid vocabulary share artifactWriter.
	outlineArtifacts := fsoutline.New(artifactWriter)
	topicCentroids := fstopics.New(artifactWriter)
	topicsDeps := tools.TopicsDeps{Catalog: sqlitecatalog.NewLazy(currentDBPath)}
	if cfg.Embed.APIKey != "" && cfg.Outline.APIKey != "" {
		embedClient, embErr := openaicompatembed.New(openaicompatembed.Config{
			Endpoint:   cfg.Embed.Endpoint,
			APIKey:     cfg.Embed.APIKey,
			Model:      cfg.Embed.Model,
			Dimensions: cfg.Embed.Dimensions,
			BatchSize:  cfg.Embed.BatchSize,
		})
		// Cluster naming reuses the outline LLM (Flash-Lite class).
		var topicNamer *openaicompattopics.Namer
		var namerErr error
		if embErr == nil {
			topicNamer, namerErr = openaicompattopics.New(openaicompattopics.Config{
				Endpoint:  cfg.Outline.Endpoint,
				APIKey:    cfg.Outline.APIKey,
				Model:     cfg.Outline.Model,
				MaxTokens: 200,
				Reasoning: cfg.Outline.Reasoning,
			})
		}
		// A misconfigured embed/namer (e.g. embed.model unset) disables only the
		// topic tools — it must not take the whole MCP server down.
		switch {
		case embErr != nil:
			log.Printf("topic recommender disabled: embeddings client: %v", embErr)
		case namerErr != nil:
			log.Printf("topic recommender disabled: topic namer: %v", namerErr)
		default:
			topicsDeps.Build = topicsapp.BuildUseCase{
				Granular:    outlineArtifacts,
				Embed:       embedClient,
				Namer:       topicNamer,
				Dict:        dictCRUDUC,
				Vocab:       topicCentroids,
				K:           150,
				Iters:       25,
				Seed:        42,
				MaxDistance: 0.45,
				Samples:     12,
			}
			topicsDeps.Assign = topicsapp.AssignUseCase{
				Embed:    embedClient,
				Granular: outlineArtifacts,
				Vocab:    topicCentroids,
				Catalog:  sqlitecatalog.NewLazy(currentDBPath),
				Langs:    []string{"ru", "en"},
			}
		}
	}

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
	}

	// One AWS uploader shared by the asset-writing tools (collection covers,
	// author avatars). Built whenever a bucket is configured, independent of
	// the image-generation API key.
	var assetUploader s3port.Uploader
	if cfg.S3.AWS.Bucket != "" {
		up, err := awss3.New(ctx, awss3.Target{
			Name:            "aws",
			Bucket:          cfg.S3.AWS.Bucket,
			Region:          cfg.S3.AWS.Region,
			Endpoint:        cfg.S3.AWS.Endpoint,
			AccessKeyID:     cfg.S3.AWS.AccessKeyID,
			SecretAccessKey: cfg.S3.AWS.SecretAccessKey,
			ForcePathStyle:  cfg.S3.AWS.ForcePathStyle,
		})
		if err != nil {
			log.Fatalf("asset uploader: %v", err)
		}
		assetUploader = up
	}

	// Cover generation (optional — disabled when images.api_key is empty).
	// One generic covergen engine, parametrized per entity (collection / topic)
	// by a thin Repo adapter and an S3 key prefix. Uploads generated covers to
	// the AWS bucket at generate time.
	var coverGen, topicCoverGen covergen.UseCase
	if cfg.Images.APIKey != "" && assetUploader != nil {
		imgClient, err := openrouterimage.New(openrouterimage.Config{
			Endpoint: cfg.Images.Endpoint,
			APIKey:   cfg.Images.APIKey,
			Model:    cfg.Images.Model,
		})
		if err != nil {
			log.Fatalf("image generator: %v", err)
		}
		coverGen = covergen.UseCase{
			Repo:     collectioncover.Repo{Catalog: sqlitecatalog.NewLazy(currentDBPath)},
			Prefix:   "public/collections",
			Images:   imgClient,
			Uploader: assetUploader,
			Style:    cfg.Images.Style,
		}
		topicCoverGen = covergen.UseCase{
			Repo:     topiccover.Repo{Catalog: sqlitecatalog.NewLazy(currentDBPath)},
			Prefix:   "public/topics",
			Images:   imgClient,
			Uploader: assetUploader,
			Style:    cfg.Images.Style,
		}
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
	configRegistry.Register(configregistry.OnboardingTopicsDescriptor())

	deps := tools.Deps{
		Registry:    registry,
		Transcripts: transcriptStore,
		Ingest: ingest.UseCase{
			Registry:   registry,
			Audio:      audioStore,
			FS:         osfs,
			Hasher:     hasher,
			Rollbacker: commitUC,
			Meta:       extractor,
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
			AlignPDF:    alignPDFOrNil(pdfAligner, &alignPDFUC),
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
			GlossaryThreshold:    cfg.Review.Glossary.MatchThreshold,
			GlossaryMaxHints:     cfg.Review.Glossary.MaxHintsPerChunk,
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
	}
	deps.AssetSync = tools.AssetSyncDeps{
		UseCase: assetsync.UseCase{OutDir: cfg.Out, Targets: publishTargets, Registry: registry},
	}
	libraryLazy := sqlitelibrary.NewLazy(libraryDBPath)
	deps.Library = tools.LibraryDeps{
		Repo: libraryLazy,
	}

	// Attribution translator — best-effort auto-translate of one source text
	// into other supported langs on library.attribution.create. Reuses the
	// resolver LLM (Flash-Lite class). Failures are non-fatal in the use case.
	attribTranslator, err := openaicompatattribtranslate.New(openaicompatattribtranslate.Config{
		Endpoint:  resCfg.Endpoint,
		APIKey:    resCfg.APIKey,
		Model:     resCfg.Model,
		MaxTokens: 200,
	})
	if err != nil {
		log.Fatalf("attribution translator: %v", err)
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

	srv := mcpsrv.New("shruti-mcp", "0.1.0")
	tools.RegisterAll(srv, deps)

	// Two MCP transports on one port (mirrors transcriber-mcp): streamable HTTP
	// at /mcp for newer clients, SSE at /sse for clients that still expect SSE.
	const (
		streamableHTTPPath = "/mcp"
		ssePath            = "/sse"
	)
	streamable := server.NewStreamableHTTPServer(srv,
		server.WithEndpointPath(streamableHTTPPath),
		server.WithHeartbeatInterval(*heartbeat),
		server.WithStateLess(true),
	)
	sse := server.NewSSEServer(srv,
		server.WithSSEEndpoint(ssePath),
		server.WithMessageEndpoint("/message"),
		server.WithKeepAliveInterval(*heartbeat),
	)

	mux := http.NewServeMux()
	mux.Handle(streamableHTTPPath, streamable)
	mux.Handle(streamableHTTPPath+"/", streamable)
	mux.Handle(ssePath, sse)
	mux.Handle("/message", sse)

	httpServer := &http.Server{
		Addr:              *addr,
		Handler:           mux,
		ReadHeaderTimeout: 30 * time.Second,
	}

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

	log.Printf("shruti-mcp listening on %s (workers=%d, transcribe-concurrency=%d, streamable=%s, sse=%s)",
		*addr, *workers, *transcribeConcurrency, streamableHTTPPath, ssePath)
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("listen: %v", err)
	}
	log.Printf("shruti-mcp stopped cleanly")
}

func printConfig(path string, cfg *config.Config) {
	fmt.Printf("shruti-mcp\n")
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
func alignerOrNil(a *pythonalign.Aligner) alignpdfport.Aligner {
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

func mustMkdirAll(p string) {
	if err := os.MkdirAll(p, 0o755); err != nil {
		log.Fatalf("mkdir %s: %v", p, err)
	}
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
		candidates = append(candidates, "shruti-mcp.yaml", "shruti-mcp.yml")
	}
	for _, c := range candidates {
		if _, err := os.Stat(c); err == nil {
			abs, _ := filepath.Abs(c)
			return abs, nil
		}
	}
	return "", fmt.Errorf("no config found; tried: %v", candidates)
}
