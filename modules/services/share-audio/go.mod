module github.com/jiva-studio/shruti-share-audio

go 1.24

require (
	github.com/go-chi/chi/v5 v5.2.4
	github.com/go-chi/cors v1.2.2
	github.com/google/uuid v1.6.0
)

require github.com/jiva-studio/shruti/logging v0.0.0

replace github.com/jiva-studio/shruti/logging => ../../libs/logging
