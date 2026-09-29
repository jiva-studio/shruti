package domain

// The two kinds of archive, and there is nothing between them.
const (
	// KindMaterial — the archive states nothing machine-readable. Whatever a
	// script collects is handed over labelled and the model reads all of it.
	KindMaterial = "material"
	// KindStated — the archive publishes its own facts, so they are taken as
	// given and no model is called.
	KindStated = "stated"
)

// Archive is a place to look: a website we crawl. It is a seed URL,
// politeness settings and what the site says about itself — there is nothing
// here describing how the site is built, because nothing needs to know.
//
// The database calls it a source, and so does the API; in this package Source
// is a scripture.
type Archive struct {
	ID       string
	Title    string
	SeedURLs []string
	Enabled  bool
	// Kind is KindMaterial or KindStated. Empty reads as material.
	Kind         string
	CrawlDelayMS int
	// CrawlWorkers is how many of this archive's pages may be in flight at once.
	CrawlWorkers int
	// Fetcher names the reader this archive needs. Empty is an ordinary request.
	Fetcher string
	// MaxDepth bounds how far from the seed a crawl will follow links. Zero,
	// the default, means no bound.
	//
	// It guards against a site that generates endlessly long addresses — a
	// calendar with a perpetual "next month", a faceted filter, a looping
	// breadcrumb — which the visited set cannot catch because every address is
	// new. It is not a way to shape a crawl: setting it right needs advance
	// knowledge of how somebody else's site is laid out, which is the one thing
	// this service is built not to assume, and guessing it wrong silently
	// truncates an archive.
	MaxDepth int

	// RecheckMinS and RecheckMaxS bound how often a page of this archive is
	// read again. Seconds, because that is what an operator types into a config
	// file and what the column holds; the schedule turns them into durations.
	RecheckMinS int
	RecheckMaxS int

	// Script names the extraction script that reads this archive. Empty means
	// the archive's own id, which is how an archive named after its script has
	// always worked.
	//
	// It exists so that several archives can share one script: fourteen
	// YouTube channels are fourteen archives — each with its own speaker, its
	// own schedule, its own account — and one youtube.js.
	Script string

	// AuthorOverride is who this archive's recordings are by, and it wins over
	// whatever the page says. Somebody setting it knows whose archive this is.
	//
	// A fallback would never fire: a script fills the author in from the
	// channel name for every video, so nothing falls through to it, and an
	// aggregator's lectures by forty people would be filed under the name of a
	// temple.
	//
	// Empty is the right answer for an archive of many speakers, and for a
	// channel that carries guests: it is an assertion, and asserting it where
	// it is not true is worse than leaving the question open.
	AuthorOverride string

	// AuthHeaders are sent with every request to this archive. They are
	// credentials: never returned by the API, only set.
	AuthHeaders map[string]string

	// HasCredentials is derived, not stored. A listing does not read the
	// headers themselves — it has no business holding a set of credentials in
	// memory — but whether an archive has any is worth showing.
	HasCredentials bool
}
