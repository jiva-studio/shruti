package tools

import (
	adminconfigapp "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/adminconfig"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/align"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/audiodenoise"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/audiotag"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/catalog/publish"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/commit"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/extractmeta"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/ingest"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/normalize"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/outline"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/registeraudio"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/review"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/runner"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/runpipeline"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/selecttracks"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/title"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/application/transcribe"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/config"
	lakeport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/lake"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/runregistry"
	transcriptport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/transcript"
	"github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/worker"
)

// Deps is the bundle of use cases and ports the MCP tools need. As phases land,
// new fields get added; main.go wires them in the composition root.
type Deps struct {
	Registry            lakeport.Registry
	Transcripts         transcriptport.Store
	Ingest              ingest.UseCase
	Normalize           normalize.UseCase
	AudioDenoise        audiodenoise.UseCase
	RegisterAudio       registeraudio.UseCase
	Metadata            extractmeta.UseCase
	Transcribe          transcribe.UseCase
	Review              review.UseCase
	ReviewBatchJobs     review.BatchStore
	AlignPDF            align.UseCase
	RefreshTitle        title.UseCase
	Outline             outline.UseCase
	Commit              commit.UseCase
	SetTrackMetadata    commit.SetTrackMetadataUseCase
	AudioTag            audiotag.UseCase
	Pipeline            runpipeline.UseCase
	Pool                *worker.Pool
	Publish             publish.UseCase
	SelectTracks        selecttracks.UseCase
	Runs                runregistry.Registry
	Runner              *runner.Runner
	DictCRUD            DictCRUDDeps
	AssetSync           AssetSyncDeps
	Topics              TopicsDeps
	CollectionCRUD      CollectionCRUDDeps
	CollectionGroupCRUD CollectionGroupCRUDDeps
	AuthorProfile       AuthorProfileDeps
	Catalog             CatalogDeps
	Library             LibraryDeps
	LibraryAttribution  LibraryAttributionDeps
	LibraryImport       LibraryImportDeps
	LibraryPublish      LibraryPublishDeps
	Pending             PendingDeps
	Proactive           ProactiveDeps
	Regions             RegionsDeps
	ConfigPublish       ConfigPublishDeps
	ConfigStore         ConfigDeps
	Wisdom              WisdomDeps
	Find                FindDeps
	InDir               string
	OutDir              string

	// AdminConfig backs admin_config_get / admin_config_set. The MCP
	// handler is a thin dispatcher; validation + dispatch lives in
	// internal/application/adminconfig. Wired in main.go from
	// internal/infra/adminconfig/runtime.
	AdminConfig adminconfigapp.Service

	// Config is the yaml-loaded effective config; kept for tools
	// outside the admin scope that still need raw config access.
	Config *config.Config
}
