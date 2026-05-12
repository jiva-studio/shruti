package sqlitecatalog

import (
	"context"

	catalogport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/catalog"
)

// SchemeReader implements catalogport.SchemeReader on top of an Open+Close
// roundtrip — used by refresh to verify a freshly-downloaded snapshot
// without giving the application layer a direct dependency on this package.
type SchemeReader struct{}

func NewSchemeReader() SchemeReader { return SchemeReader{} }

func (SchemeReader) ReadScheme(ctx context.Context, dbPath string) (int, error) {
	r, err := Open(ctx, dbPath)
	if err != nil {
		return 0, err
	}
	defer r.Close()
	return r.Scheme(ctx)
}

var _ catalogport.SchemeReader = (*SchemeReader)(nil)
