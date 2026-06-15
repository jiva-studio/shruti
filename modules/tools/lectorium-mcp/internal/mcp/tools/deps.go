package tools

import (
	adminconfigapp "github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/application/adminconfig"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/application/alignpdf"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/application/audiodenoise"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/application/audiotag"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/application/catalog/publish"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/application/commit"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/application/extractmeta"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/application/ingest"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/application/normalize"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/application/outline"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/application/review"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/application/runner"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/application/runpipeline"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/application/selecttracks"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/application/title"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/application/transcribe"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/config"
	lakeport "github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/ports/lake"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/ports/runregistry"
	transcriptport "github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/ports/transcript"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/worker"
)

// Deps is the bundle of use cases and ports the MCP tools need. As phases land,
// new fields get added; main.go wires them in the composition root.
type Deps struct {
	Registry            lakeport.Registry
	Transcripts         transcriptport.Store
	Ingest              ingest.UseCase
	Normalize           normalize.UseCase
	AudioDenoise        audiodenoise.UseCase
	Metadata            extractmeta.UseCase
	Transcribe          transcribe.UseCase
	Review              review.UseCase
	AlignPDF            alignpdf.UseCase
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
	CollectionCRUD      CollectionCRUDDeps
	CollectionGroupCRUD CollectionGroupCRUDDeps
	AuthorProfile       AuthorProfileDeps
	Catalog             CatalogDeps
	Library             LibraryDeps
	LibraryAttribution  LibraryAttributionDeps
	LibraryImport       LibraryImportDeps
	LibraryPublish      LibraryPublishDeps
	Proactive           ProactiveDeps
	Regions             RegionsDeps
	ConfigPublish       ConfigPublishDeps
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
