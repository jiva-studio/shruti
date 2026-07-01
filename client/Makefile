# Client build: Wails v2 (Go + Vue) → single native binary at build/bin/shruti.
# GOWORK=off so the client module resolves proto via its replace directive
# instead of the repo go.work (which also lists host modules).
.PHONY: build clean
build:
	GOWORK=off wails build -tags webkit2_41 -clean

clean:
	rm -rf build/bin frontend/dist frontend/node_modules
