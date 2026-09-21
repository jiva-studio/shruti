// vk-reconcile builds the VK wisdom→audio id mapping in state.db after a
// batch of ID3-tagged excerpts has been uploaded to a community. It reads
// the community's audio list (VK audio.get, or a --from-file export when the
// API is inaccessible), extracts the wisdom id from each track's artist
// ("LW:<wisdom_id>"), tie-breaks by duration against the download manifest,
// and upserts state.vk_audio_map.
//
// Usage:
//
//	vk-reconcile -state /var/lib/social-poster/state.db \
//	             -group 123456 -token $VK_COMMUNITY_TOKEN \
//	             -manifest resources/daily-wisdom/vk-upload/manifest.jsonl
//	# or, if audio.get is blocked, from an exported JSON list:
//	vk-reconcile -state … -group 123456 -from-file audios.json -manifest …
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/jiva-studio/lectorium-social-poster/internal/state"
)

const vkAPIVersion = "5.199"

var artistRe = regexp.MustCompile(`LW:(wisdom_[A-Za-z0-9]+)`)

type vkAudio struct {
	ID       int64  `json:"id"`
	OwnerID  int64  `json:"owner_id"`
	Artist   string `json:"artist"`
	Title    string `json:"title"`
	Duration int    `json:"duration"`
}

func main() { os.Exit(run()) }

func run() int {
	var (
		statePath = flag.String("state", "", "path to state.db (required)")
		group     = flag.String("group", "", "VK community numeric id (required)")
		token     = flag.String("token", os.Getenv("VK_COMMUNITY_TOKEN"), "VK token (or VK_COMMUNITY_TOKEN env)")
		manifest  = flag.String("manifest", "", "download manifest.jsonl (duration tie-break)")
		fromFile  = flag.String("from-file", "", "read audio list from a JSON file instead of audio.get")
		importMap = flag.String("import-map", "", "import a {wisdom_id,owner_id,audio_id} jsonl map (from upload_vk_audio.py) instead of calling VK")
		dryRun    = flag.Bool("dry-run", false, "print the mapping without writing state")
	)
	flag.Parse()
	if *statePath == "" {
		fmt.Fprintln(os.Stderr, "-state is required")
		return 2
	}

	ctx := context.Background()

	// Import path: the uploader already produced the id map, so just load it
	// into state.db — no VK API call, no -group needed.
	if *importMap != "" {
		if err := runImport(ctx, *statePath, *importMap, *dryRun); err != nil {
			fmt.Fprintln(os.Stderr, "import:", err)
			return 1
		}
		return 0
	}

	if *group == "" {
		fmt.Fprintln(os.Stderr, "-group is required (or use -import-map)")
		return 2
	}
	durByID := loadManifestDurations(*manifest) // wisdom_id -> duration_sec (rounded)
	idByDur := invertUnique(durByID)            // duration_sec -> wisdom_id (only uniques)

	var audios []vkAudio
	var err error
	if *fromFile != "" {
		audios, err = readAudioFile(*fromFile)
	} else {
		if *token == "" {
			fmt.Fprintln(os.Stderr, "need -token/VK_COMMUNITY_TOKEN (or use -from-file)")
			return 2
		}
		audios, err = fetchAudios(ctx, *token, *group)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "load audios:", err)
		return 1
	}

	st, err := state.Open(ctx, *statePath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "open state:", err)
		return 1
	}
	defer st.Close()

	var mapped, byArtist, byDur, unmatched int
	for _, a := range audios {
		wid := ""
		if m := artistRe.FindStringSubmatch(a.Artist); m != nil {
			wid, byArtist = m[1], byArtist+1
		} else if id, ok := idByDur[a.Duration]; ok {
			wid, byDur = id, byDur+1
		}
		if wid == "" {
			unmatched++
			continue
		}
		owner := fmt.Sprintf("%d", a.OwnerID)
		if owner == "0" {
			owner = "-" + *group
		}
		fmt.Printf("  %s -> audio%s_%d  (artist=%q dur=%ds)\n", wid, owner, a.ID, a.Artist, a.Duration)
		if !*dryRun {
			if err := st.SetVKAudio(ctx, wid, owner, fmt.Sprintf("%d", a.ID)); err != nil {
				fmt.Fprintln(os.Stderr, "write map:", err)
				return 1
			}
		}
		mapped++
	}
	fmt.Printf("mapped=%d (by_artist=%d by_duration=%d) unmatched=%d total_audios=%d dry_run=%v\n",
		mapped, byArtist, byDur, unmatched, len(audios), *dryRun)
	return 0
}

// runImport loads a {wisdom_id,owner_id,audio_id} jsonl map into state.db.
func runImport(ctx context.Context, statePath, mapPath string, dry bool) error {
	f, err := os.Open(mapPath)
	if err != nil {
		return err
	}
	defer f.Close()

	var st *state.State
	if !dry {
		st, err = state.Open(ctx, statePath)
		if err != nil {
			return err
		}
		defer st.Close()
	}

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	n := 0
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var m struct {
			WisdomID string `json:"wisdom_id"`
			OwnerID  string `json:"owner_id"`
			AudioID  string `json:"audio_id"`
		}
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			return err
		}
		if m.WisdomID == "" || m.AudioID == "" {
			continue
		}
		if dry {
			fmt.Printf("  %s -> audio%s_%s\n", m.WisdomID, m.OwnerID, m.AudioID)
		} else if err := st.SetVKAudio(ctx, m.WisdomID, m.OwnerID, m.AudioID); err != nil {
			return err
		}
		n++
	}
	if err := sc.Err(); err != nil {
		return err
	}
	fmt.Printf("imported=%d dry_run=%v\n", n, dry)
	return nil
}

func fetchAudios(ctx context.Context, token, group string) ([]vkAudio, error) {
	httpc := &http.Client{Timeout: 30 * time.Second}
	var all []vkAudio
	offset := 0
	for {
		form := url.Values{
			"owner_id":     {"-" + group},
			"count":        {"200"},
			"offset":       {fmt.Sprintf("%d", offset)},
			"access_token": {token},
			"v":            {vkAPIVersion},
		}
		req, _ := http.NewRequestWithContext(ctx, http.MethodPost,
			"https://api.vk.com/method/audio.get", strings.NewReader(form.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		resp, err := httpc.Do(req)
		if err != nil {
			return nil, err
		}
		var out struct {
			Response struct {
				Count int       `json:"count"`
				Items []vkAudio `json:"items"`
			} `json:"response"`
			Error *struct {
				Code int    `json:"error_code"`
				Msg  string `json:"error_msg"`
			} `json:"error"`
		}
		err = json.NewDecoder(resp.Body).Decode(&out)
		resp.Body.Close()
		if err != nil {
			return nil, err
		}
		if out.Error != nil {
			return nil, fmt.Errorf("vk audio.get error %d: %s (audio API may be closed for this token — use -from-file)",
				out.Error.Code, out.Error.Msg)
		}
		all = append(all, out.Response.Items...)
		offset += len(out.Response.Items)
		if len(out.Response.Items) == 0 || offset >= out.Response.Count {
			break
		}
	}
	return all, nil
}

func readAudioFile(path string) ([]vkAudio, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	// Accept either a bare array or the full {response:{items:[…]}} envelope.
	var arr []vkAudio
	if json.Unmarshal(raw, &arr) == nil && len(arr) > 0 {
		return arr, nil
	}
	var env struct {
		Response struct {
			Items []vkAudio `json:"items"`
		} `json:"response"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, err
	}
	return env.Response.Items, nil
}

func loadManifestDurations(path string) map[string]int {
	out := map[string]int{}
	if path == "" {
		return out
	}
	f, err := os.Open(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, "warn: manifest:", err)
		return out
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	for sc.Scan() {
		var row struct {
			ID          string  `json:"id"`
			DurationSec float64 `json:"duration_sec"`
		}
		if json.Unmarshal(sc.Bytes(), &row) == nil && row.ID != "" {
			out[row.ID] = int(row.DurationSec + 0.5)
		}
	}
	return out
}

// invertUnique maps duration→wisdom_id keeping only durations that belong to
// exactly one wisdom id (safe for tie-break).
func invertUnique(durByID map[string]int) map[int]string {
	count := map[int]int{}
	for _, d := range durByID {
		count[d]++
	}
	out := map[int]string{}
	for id, d := range durByID {
		if count[d] == 1 {
			out[d] = id
		}
	}
	return out
}
