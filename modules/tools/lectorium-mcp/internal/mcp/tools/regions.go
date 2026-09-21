package tools

import (
	"context"
	"errors"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/catalog/regions"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/mcp/envelope"
)

// RegionsDeps bundles the regions use-case for tool wiring. Wired in main.go
// (sharing publish's S3 targets + catalogOpMutex) and passed to
// RegisterCatalogRegions from tools.RegisterAll.
type RegionsDeps struct {
	UseCase regions.UseCase
}

func RegisterCatalogRegions(s *server.MCPServer, deps RegionsDeps) {
	registerRegionsList(s, deps)
	registerRegionsGet(s, deps)
	registerRegionsUpsert(s, deps)
	registerRegionsRemove(s, deps)
}

func registerRegionsList(s *server.MCPServer, deps RegionsDeps) {
	const kind = "catalog.config.regions.list"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("List the CDN/region endpoints from the LOCAL config.json `regions` section (the editable source-of-truth, not yet published unless catalog.config.publish / catalog.publish has run). This is the list the mobile app downloads on startup; the bundled servers.ts list is only a first-launch bootstrap."),
	)
	s.AddTool(tool, func(ctx context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		out, err := deps.UseCase.List()
		if err != nil {
			return envelopeFromRegionsError(kind, err), nil
		}
		return envelope.Result(kind, map[string]any{"regions": out}), nil
	})
}

func registerRegionsGet(s *server.MCPServer, deps RegionsDeps) {
	const kind = "catalog.config.regions.get"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Read one region by id from the local config.json. Returns not_found if absent."),
		mcp.WithString("id", mcp.Required(), mcp.Description("Region id, e.g. \"global\" | \"russia\".")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, err := req.RequireString("id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		out, err := deps.UseCase.Get(id)
		if err != nil {
			return envelopeFromRegionsError(kind, err), nil
		}
		return envelope.Result(kind, out), nil
	})
}

func registerRegionsUpsert(s *server.MCPServer, deps RegionsDeps) {
	const kind = "catalog.config.regions.upsert"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Add or replace (by id, in place) one region in the LOCAL config.json. Edits the local source only — run catalog.config.publish to push it to S3 (config-only, no DB bump), or catalog.publish for a full publish. All URL fields are required and must be https; urlTemplate must contain the {path} placeholder."),
		mcp.WithString("id", mcp.Required(), mcp.Description("Region id, [a-z0-9-]+. Example: \"europe\".")),
		mcp.WithString("name", mcp.Required(), mcp.Description("Display name shown in the app's server picker, e.g. \"Europe\".")),
		mcp.WithString("urlTemplate", mcp.Required(), mcp.Description("Public bucket URL template for content, with a {path} placeholder, e.g. \"https://bucket.example.com/{path}\".")),
		mcp.WithString("shareAudioUrl", mcp.Required(), mcp.Description("Share-audio excerpts endpoint, e.g. \"https://host/share/audio/excerpts\".")),
		mcp.WithString("shareVideoUrl", mcp.Required(), mcp.Description("Share-video reels endpoint, e.g. \"https://host/share/video/reels\".")),
		mcp.WithString("authBaseUrl", mcp.Required(), mcp.Description("Auth service base URL, e.g. \"https://host/auth\".")),
		mcp.WithString("chatBaseUrl", mcp.Required(), mcp.Description("Chat service base URL, e.g. \"https://host\".")),
		mcp.WithString("profileBaseUrl", mcp.Description("OPTIONAL profile-sync service base URL, e.g. \"https://host\". Omit/empty ⇒ the region ships without it and the client's profile-sync engine stays OFF (no chatBaseUrl fallback); set it to turn read-only chat-history sync on. Must be https when supplied.")),
		mcp.WithString("orchestratorBaseUrl", mcp.Description("OPTIONAL ingest control-plane base URL, e.g. \"https://host\" (routes /orchestrator/ingest). Omit/empty ⇒ the region ships without it and the client's add-by-url / status polling stays OFF; set it to turn direct ingest on. Must be https when supplied.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		fields := map[string]string{}
		for _, key := range []string{"id", "name", "urlTemplate", "shareAudioUrl", "shareVideoUrl", "authBaseUrl", "chatBaseUrl"} {
			v, err := req.RequireString(key)
			if err != nil {
				return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
			}
			fields[key] = v
		}
		out, err := deps.UseCase.Upsert(regions.Region{
			ID:                  fields["id"],
			Name:                fields["name"],
			URLTemplate:         fields["urlTemplate"],
			ShareAudioURL:       fields["shareAudioUrl"],
			ShareVideoURL:       fields["shareVideoUrl"],
			AuthBaseURL:         fields["authBaseUrl"],
			ChatBaseURL:         fields["chatBaseUrl"],
			ProfileBaseURL:      req.GetString("profileBaseUrl", ""),
			OrchestratorBaseURL: req.GetString("orchestratorBaseUrl", ""),
		})
		if err != nil {
			return envelopeFromRegionsError(kind, err), nil
		}
		return envelope.Result(kind, out), nil
	})
}

func registerRegionsRemove(s *server.MCPServer, deps RegionsDeps) {
	const kind = "catalog.config.regions.remove"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Remove one region by id from the local config.json. Returns not_found if absent, or conflict if it is the last remaining region. Publish (catalog.config.publish) to apply."),
		mcp.WithString("id", mcp.Required()),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, err := req.RequireString("id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		removed, err := deps.UseCase.Remove(id)
		if err != nil {
			return envelopeFromRegionsError(kind, err), nil
		}
		return envelope.Result(kind, map[string]any{"removed": removed}), nil
	})
}

// envelopeFromRegionsError maps regions domain errors to envelope codes.
func envelopeFromRegionsError(kind string, err error) *mcp.CallToolResult {
	var ve *regions.ValidationError
	if errors.As(err, &ve) {
		return envelope.Err(kind, envelope.CodeValidationFailed, ve.Error(), map[string]any{"field": ve.Field})
	}
	var nfe *regions.NotFoundError
	if errors.As(err, &nfe) {
		return envelope.Err(kind, envelope.CodeNotFound, nfe.Error(), map[string]any{"entity": "region", "id": nfe.Key})
	}
	var ce *regions.ConflictError
	if errors.As(err, &ce) {
		return envelope.Err(kind, envelope.CodeConflict, ce.Error(), nil)
	}
	return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil)
}
