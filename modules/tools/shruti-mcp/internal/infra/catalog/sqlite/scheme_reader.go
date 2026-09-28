package sqlitecatalog

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/jiva-studio/shruti/catalogdb"
	catalogport "github.com/jiva-studio/shruti/modules/tools/shruti-mcp/internal/ports/catalog"
)

// SchemeReader reads a downloaded snapshot's scheme. The file is opened
// immutable, so neither a migration nor a write-ahead log touches it.
type SchemeReader struct{}

func NewSchemeReader() SchemeReader { return SchemeReader{} }

func (SchemeReader) ReadScheme(ctx context.Context, dbPath string) (scheme int, err error) {
	db, err := sql.Open("sqlite3", fmt.Sprintf("file:%s?mode=ro&immutable=1", dbPath))
	if err != nil {
		return 0, fmt.Errorf("open %s: %w", dbPath, err)
	}
	defer func() { err = errors.Join(err, db.Close()) }()
	return catalogdb.ReadScheme(ctx, db)
}

var _ catalogport.SchemeReader = SchemeReader{}
