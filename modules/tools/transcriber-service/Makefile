.PHONY: build build-go build-swift run clean test fmt vet

BIN := bin/transcriber-service
FLUIDBATCHD := fluidbatchd/.build/release/fluidbatchd

build: build-swift build-go

build-swift:
	cd fluidbatchd && swift build -c release

build-go: $(BIN)

$(BIN): $(shell find . -name '*.go' -not -path './fluidbatchd/*' 2>/dev/null) go.mod
	@mkdir -p bin
	go build -o $(BIN) ./cmd/transcriber-service

run: build
	./$(BIN)

test:
	go test ./...

fmt:
	gofmt -w $(shell find . -name '*.go' -not -path './fluidbatchd/*' 2>/dev/null)

vet:
	go vet ./...

clean:
	rm -rf bin fluidbatchd/.build
