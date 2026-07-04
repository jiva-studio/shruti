package mcpsrv

import _ "embed"

// Built from the vite project in ../../ui (singlefile ext-apps bundle).
// Rebuild after editing ui/:  cd ui && npm run build

//go:embed dist/media-player.html
var mediaPlayerHTML string

//go:embed dist/excerpt-player.html
var excerptPlayerHTML string
