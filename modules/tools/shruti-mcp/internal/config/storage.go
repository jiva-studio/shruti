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

// S3 lists the publish targets.
type S3 struct {
	AWS    S3Target    `yaml:"aws"`
	Yandex S3Target    `yaml:"yandex"`
	Bunny  BunnyTarget `yaml:"bunny"`
}

type S3Target struct {
	Bucket          string `yaml:"bucket"`
	Region          string `yaml:"region"`
	Endpoint        string `yaml:"endpoint"`
	AccessKeyID     string `yaml:"access_key_id"`
	SecretAccessKey string `yaml:"secret_access_key"`
	ForcePathStyle  bool   `yaml:"force_path_style"`
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
	// AWS is opt-in: the catalog publishes to Bunny Edge Storage. The region
	// is defaulted only when a bucket is configured — an empty aws block means
	// "no S3 publish target", and the container skips it.
	if s.AWS.Bucket != "" && s.AWS.Region == "" {
		s.AWS.Region = "us-east-1"
	}
	if s.Yandex.Region == "" {
		s.Yandex.Region = "ru-central1"
	}
	if s.Yandex.Endpoint == "" {
		s.Yandex.Endpoint = "https://storage.yandexcloud.net"
	}
	if s.Bunny.Zone != "" && s.Bunny.Endpoint == "" {
		s.Bunny.Endpoint = "https://storage.bunnycdn.com"
	}
}
