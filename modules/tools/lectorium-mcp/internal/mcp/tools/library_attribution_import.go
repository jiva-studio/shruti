package tools

import (
	"context"
	"fmt"
	"os"

	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"

	attributionapp "github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/application/library/attribution"
	"github.com/jiva-studio/lectorium/modules/tools/lectorium-mcp/internal/mcp/envelope"
)

// registerAttributionImport wires library.attribution.import — bulk-create
// attributions from a verse-centric YAML plan. Replaces the standalone Python
// attribution-importer: same YAML format, same aggregation, but driven inside
// the MCP server through the same Create/RefAdd use cases. Idempotent (Create
// reuses existing by text, RefAdd is INSERT OR IGNORE) so it's safe to re-run
// without external checkpoints. Publishing stays separate (library.publish).
func registerAttributionImport(s *server.MCPServer, deps LibraryAttributionDeps) {
	const kind = "library.attribution.import"
	t := mcp.NewTool(kind,
		mcp.WithDescription(
			"Bulk-import attributions from a verse-centric YAML plan. Provide the "+
				"plan as `yaml` (inline content) OR `yaml_path` (file on the server). "+
				"Each verse lists `topics` (→ kind=boost) and `questions` (→ kind=pinned); "+
				"identical text across verses collapses into one attribution with "+
				"multiple refs. Idempotent: re-running skips already-created entries and "+
				"never duplicates. Run library.publish afterwards to push library.db."),
		mcp.WithString("yaml", mcp.Description("Inline YAML plan content. Mutually exclusive with yaml_path.")),
		mcp.WithString("yaml_path", mcp.Description("Path to a YAML plan file on the server. Mutually exclusive with yaml.")),
	)
	s.AddTool(t, func(ctx context.Context, req mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		inline := req.GetString("yaml", "")
		path := req.GetString("yaml_path", "")
		if (inline == "") == (path == "") {
			return envelope.Err(kind, envelope.CodeInvalidArgument,
				"provide exactly one of `yaml` or `yaml_path`", nil), nil
		}
		var data []byte
		if inline != "" {
			data = []byte(inline)
		} else {
			b, err := os.ReadFile(path)
			if err != nil {
				return envelope.Err(kind, envelope.CodeInvalidArgument,
					fmt.Sprintf("read yaml_path: %v", err), nil), nil
			}
			data = b
		}
		plan, err := attributionapp.ParseImportPlan(data)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInvalidArgument, err.Error(), nil), nil
		}
		res, err := deps.UseCase.Import(ctx, plan)
		if err != nil {
			return envelope.Err(kind, envelope.CodeInternal, err.Error(), nil), nil
		}
		return envelope.Result(kind, res), nil
	})
}
