package review

import (
	"encoding/json"
	"os"
)

func readWholeFile(p string) ([]byte, error) { return os.ReadFile(p) }
func jsonDecode(b []byte, v any) error      { return json.Unmarshal(b, v) }
