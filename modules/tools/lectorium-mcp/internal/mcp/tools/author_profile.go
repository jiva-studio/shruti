package tools

import (
	"context"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/application/catalog/authorprofile"
	"github.com/akdasa-studios/lectorium/modules/tools/lectorium-mcp/internal/mcp/envelope"
)

// AuthorProfileDeps wires the author avatar/bio tools to the authorprofile use
// case. UseCase.Uploader is nil when no S3 bucket is configured, in which case
// author.image.upload reports image upload as unconfigured.
type AuthorProfileDeps struct {
	UseCase authorprofile.UseCase
}

// RegisterAuthorProfile registers the author profile tools:
//
//	author.description.set / author.image.upload
func RegisterAuthorProfile(s *server.MCPServer, deps AuthorProfileDeps) {
	registerAuthorDescriptionSet(s, deps)
	registerAuthorImageUpload(s, deps)
}

func registerAuthorDescriptionSet(s *server.MCPServer, deps AuthorProfileDeps) {
	kind := "author.description.set"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Set the short bio for one (author id, language). Shown in the mobile collection-detail author header."),
		mcp.WithString("id", mcp.Required()),
		mcp.WithString("language", mcp.Required(), mcp.Description("Locale code (ru / en).")),
		mcp.WithString("description", mcp.Required(), mcp.Description("Short author bio in this locale.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, err := req.RequireString("id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		lang, err := req.RequireString("language")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		desc, err := req.RequireString("description")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		if err := deps.UseCase.SetDescription(ctx, id, lang, desc); err != nil {
			return envelope.Err(kind, envelope.CodeNotFound, err.Error(), nil), nil
		}
		return envelope.Result(kind, map[string]any{"id": id, "language": lang}), nil
	})
}

func registerAuthorImageUpload(s *server.MCPServer, deps AuthorProfileDeps) {
	kind := "author.image.upload"
	tool := mcp.NewTool(kind,
		mcp.WithDescription("Fetch an avatar from an http(s) URL or local file path, normalise it to JPEG, upload it to public/authors/<id>/avatar.jpg, and record the key on every locale of the author."),
		mcp.WithString("id", mcp.Required()),
		mcp.WithString("source", mcp.Required(), mcp.Description("http(s) URL or local file path of the source image.")),
	)
	s.AddTool(tool, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, err := req.RequireString("id")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		source, err := req.RequireString("source")
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		if !deps.UseCase.Enabled() {
			return envelope.Err(kind, envelope.CodeInvalidArgument, "image upload is not configured (no S3 bucket)", nil), nil
		}
		key, err := deps.UseCase.UploadImage(ctx, id, source)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, map[string]any{"id": id, "image": key}), nil
	})
}
