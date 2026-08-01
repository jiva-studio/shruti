module github.com/jiva-studio/lectorium/discovery

go 1.26.2

require (
	github.com/go-chi/chi/v5 v5.2.4
	github.com/google/uuid v1.6.0
	github.com/hashicorp/go-retryablehttp v0.7.8
	github.com/jackc/pgx/v5 v5.9.2
	github.com/temoto/robotstxt v1.1.2
	golang.org/x/net v0.39.0
	golang.org/x/time v0.15.0
)

require (
	github.com/hashicorp/go-cleanhttp v0.5.2 // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	golang.org/x/sync v0.17.0 // indirect
	golang.org/x/text v0.29.0 // indirect
)

require github.com/jiva-studio/lectorium/pipeline v0.0.0

replace github.com/jiva-studio/lectorium/pipeline => ../../libs/pipeline
