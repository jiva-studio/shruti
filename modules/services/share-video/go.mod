module github.com/jiva-studio/shruti-share-video

go 1.25.0

require (
	github.com/fogleman/gg v1.3.0
	github.com/go-chi/chi/v5 v5.2.4
	github.com/golang-jwt/jwt/v5 v5.3.1
	github.com/google/uuid v1.6.0
	github.com/jackc/pgx/v5 v5.9.2
	github.com/redis/go-redis/v9 v9.19.0
	golang.org/x/image v0.41.0
	golang.org/x/sync v0.20.0
)

require (
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/golang/freetype v0.0.0-20170609003504-e2365dfdc4a0 // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	github.com/jiva-studio/shruti/authjwt v0.0.0
	github.com/jiva-studio/shruti/logging v0.0.0
	go.uber.org/atomic v1.11.0 // indirect
	golang.org/x/text v0.37.0 // indirect
)

replace github.com/jiva-studio/shruti/authjwt => ../../libs/authjwt

replace github.com/jiva-studio/shruti/logging => ../../libs/logging
