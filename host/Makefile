# Host build: Swift ASR daemon + Go WebSocket server → host/bin/
# Mirrors lectorium's transcriber-service (swift build -c release + go build).
BIN := bin

.PHONY: build fluidstreamd streamd clean
build: fluidstreamd streamd

fluidstreamd:
	cd fluidstreamd && swift build -c release
	@mkdir -p $(BIN)
	cp fluidstreamd/.build/release/fluidstreamd $(BIN)/fluidstreamd

streamd:
	@mkdir -p $(BIN)
	cd streamd && go build -o ../$(BIN)/streamd .

clean:
	rm -rf $(BIN) fluidstreamd/.build
