module github.com/jiva-studio/shruti/host/streamd

go 1.23

require (
	github.com/coder/websocket v1.8.15
	github.com/jiva-studio/shruti/proto v0.0.0
)

// proto is resolved locally through ../../go.work; the replace lets the module
// graph resolve the pseudo-version v0.0.0 without a network fetch (needed once
// streamd has an external dependency).
replace github.com/jiva-studio/shruti/proto => ../../proto
