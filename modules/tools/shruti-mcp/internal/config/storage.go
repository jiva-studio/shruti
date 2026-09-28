package config

// CDN is where the published catalog is read from.
type CDN struct {
	ReadBaseURL string `yaml:"read_base_url"`
}

func (c *CDN) applyDefaults() {
	if c.ReadBaseURL == "" {
		c.ReadBaseURL = "https://cdn.shruti.local"
	}
}

// S3 holds the publish target: the Bunny storage zone.
type S3 struct {
	Bunny BunnyTarget `yaml:"bunny"`
}

// BunnyTarget configures a Bunny.net Edge Storage publish target. Bunny is not
// S3-compatible, so it has its own shape: Zone is the storage-zone name,
// AccessKey is the storage-zone password (read+write), Endpoint defaults to the
// main storage host. Enabled when Zone is non-empty.
type BunnyTarget struct {
	Zone      string `yaml:"zone"`
	Endpoint  string `yaml:"endpoint"`
	AccessKey string `yaml:"access_key"`
}

func (s *S3) applyDefaults() {
	if s.Bunny.Zone != "" && s.Bunny.Endpoint == "" {
		s.Bunny.Endpoint = "https://storage.bunnycdn.com"
	}
}
