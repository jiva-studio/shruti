.PHONY: build run test fmt vet clean

BIN := bin/transcriber-mcp

build: $(BIN)

$(BIN): $(shell find . -name '*.go' 2>/dev/null) go.mod
	@mkdir -p bin
	go build -o $(BIN) ./cmd/transcriber-mcp

run: build
	./$(BIN)

test:
	go test ./...

fmt:
	gofmt -w $(shell find . -name '*.go' 2>/dev/null)

vet:
	go vet ./...

clean:
	rm -rf bin
