package config

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
)

// loadDotEnvNear loads `.env` files in priority order: same directory as
// configPath, then the current working directory. Each file's KEY=VALUE
// lines are exported into os.Environ unless the variable is already set
// (existing env always wins so explicit shell exports beat file content).
func loadDotEnvNear(configPath string) {
	candidates := []string{}
	if configPath != "" {
		candidates = append(candidates, filepath.Join(filepath.Dir(configPath), ".env"))
	}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates, filepath.Join(cwd, ".env"))
	}
	seen := map[string]struct{}{}
	for _, p := range candidates {
		abs, _ := filepath.Abs(p)
		if _, dup := seen[abs]; dup {
			continue
		}
		seen[abs] = struct{}{}
		_ = loadDotEnvFile(abs)
	}
}

func loadDotEnvFile(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		// Drop "export " prefix shell users sometimes write.
		line = strings.TrimPrefix(line, "export ")
		eq := strings.IndexByte(line, '=')
		if eq <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		val := strings.TrimSpace(line[eq+1:])
		val = strings.Trim(val, `"'`)
		if _, already := os.LookupEnv(key); already {
			continue
		}
		_ = os.Setenv(key, val)
	}
	return sc.Err()
}
