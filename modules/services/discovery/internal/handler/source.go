package handler

import "github.com/jiva-studio/shruti/discovery/internal/store"

// The API's idea of a source is written out here rather than borrowed from the
// row type, for two reasons that are not about tidiness.
//
// Inbound: decoding a request straight into store.Source makes every column the
// table happens to have into a field a caller can set, and that list grows
// whenever the schema does. What a caller may set is a smaller, slower-moving
// list, and it should be visible in one place.
//
// Outbound: credentials used to be removed by hand at three separate points, by
// two different mechanisms, and the fourth handler was one forgotten line away
// from shipping them. sourceOut has no field for them, so there is nothing to
// forget.

// sourceIn is what a caller may set on a source.
type sourceIn struct {
	ID           string   `json:"id"`
	Title        string   `json:"title"`
	SeedURLs     []string `json:"seed_urls"`
	Enabled      bool     `json:"enabled"`
	CrawlDelayMS int      `json:"crawl_delay_ms"`
	CrawlWorkers int      `json:"crawl_workers"`
	Fetcher      string   `json:"fetcher"`
	MaxDepth     int      `json:"max_depth"`
	RecheckMinS  int      `json:"recheck_min_s"`
	RecheckMaxS  int      `json:"recheck_max_s"`
	// Script names the extraction script that reads this source. Empty means
	// the source's own id. Several sources may name one script — fourteen
	// YouTube channels are fourteen sources and one youtube.js.
	Script string `json:"script"`
	// DefaultAuthor is who a recording is by when the page does not say — a
	// personal channel's owner. Leave it empty for an archive of many speakers,
	// or every talk on it is filed under one name that is not a person.
	DefaultAuthor string `json:"default_author"`
	// AuthHeaders go in and never come back out. Omitting them leaves whatever
	// was set before, so an edit does not sign the source out of the archive.
	AuthHeaders map[string]string `json:"auth_headers,omitempty"`
}

func (in sourceIn) source() store.Source {
	return store.Source{
		ID:            in.ID,
		Title:         in.Title,
		SeedURLs:      in.SeedURLs,
		Enabled:       in.Enabled,
		CrawlDelayMS:  in.CrawlDelayMS,
		CrawlWorkers:  in.CrawlWorkers,
		Fetcher:       in.Fetcher,
		MaxDepth:      in.MaxDepth,
		RecheckMinS:   in.RecheckMinS,
		RecheckMaxS:   in.RecheckMaxS,
		Script:        in.Script,
		DefaultAuthor: in.DefaultAuthor,
		AuthHeaders:   in.AuthHeaders,
	}
}

// sourceOut is a source as the API shows it. There is no credential on it and
// there cannot be one.
type sourceOut struct {
	ID           string   `json:"id"`
	Title        string   `json:"title,omitempty"`
	SeedURLs     []string `json:"seed_urls"`
	Enabled      bool     `json:"enabled"`
	CrawlDelayMS int      `json:"crawl_delay_ms"`
	CrawlWorkers int      `json:"crawl_workers"`
	Fetcher      string   `json:"fetcher,omitempty"`
	MaxDepth     int      `json:"max_depth"`
	RecheckMinS  int      `json:"recheck_min_s"`
	RecheckMaxS  int      `json:"recheck_max_s"`
	// Script is the extraction script that reads this source; empty means its
	// own id.
	Script string `json:"script,omitempty"`
	// DefaultAuthor is who this source's recordings are by when the page does
	// not say. Empty means the page has to.
	DefaultAuthor string `json:"default_author,omitempty"`
	// HasCredentials says whether requests to this source carry an account,
	// which is worth knowing and is not the account itself.
	HasCredentials bool `json:"has_credentials,omitempty"`
}

func sourceFrom(s store.Source) sourceOut {
	return sourceOut{
		ID:             s.ID,
		Title:          s.Title,
		SeedURLs:       s.SeedURLs,
		Enabled:        s.Enabled,
		CrawlDelayMS:   s.CrawlDelayMS,
		CrawlWorkers:   s.CrawlWorkers,
		Fetcher:        s.Fetcher,
		MaxDepth:       s.MaxDepth,
		RecheckMinS:    s.RecheckMinS,
		RecheckMaxS:    s.RecheckMaxS,
		Script:         s.Script,
		DefaultAuthor:  s.DefaultAuthor,
		HasCredentials: s.HasCredentials,
	}
}
