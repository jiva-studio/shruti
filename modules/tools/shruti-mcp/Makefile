.PHONY: build test test-smoke lint run clean up down restart status logs

BIN     := ./bin/shruti-mcp
PID     := /tmp/shruti-mcp.pid
LOG     := /tmp/shruti-mcp.log
ADDR   ?= 127.0.0.1:8081
# RUN_DIR holds the shruti-mcp.yaml + .env. Default is the module
# root (where this Makefile lives) — config and binary stay together.
# Override via `make up RUN_DIR=/some/other/dir` for non-standard layouts.
RUN_DIR ?= $(CURDIR)

build:
	go build -o $(BIN) ./cmd/shruti-mcp

test:
	go test ./...

test-smoke:
	go test -tags=smoke ./...

# Run staticcheck across the module. Not part of `make build` — it's
# advisory; install once via:
#   go install honnef.co/go/tools/cmd/staticcheck@latest
lint:
	@if ! command -v staticcheck >/dev/null 2>&1; then \
		echo "staticcheck not in PATH; install with:"; \
		echo "  go install honnef.co/go/tools/cmd/staticcheck@latest"; \
		exit 1; \
	fi
	staticcheck ./...

run: build
	cd $(RUN_DIR) && $(CURDIR)/$(BIN) -addr $(ADDR)

clean:
	rm -rf ./bin

# --- daemon lifecycle (mirror transcriber-mcp orchestrator pattern) ---

up: build
	@if pgrep -x shruti-mcp >/dev/null 2>&1; then \
		echo "shruti-mcp already running (pid $$(pgrep -x shruti-mcp | head -1))"; \
	else \
		( cd $(RUN_DIR) && nohup $(CURDIR)/$(BIN) -addr $(ADDR) >$(LOG) 2>&1 & ); \
		sleep 0.5; \
		pgrep -x shruti-mcp | head -1 >$(PID); \
		echo "shruti-mcp: started pid $$(cat $(PID)), addr=$(ADDR), log=$(LOG)"; \
	fi

down:
	@stopped=0; \
	if [ -f $(PID) ]; then \
		pid=$$(cat $(PID)); \
		if [ -n "$$pid" ] && kill -0 $$pid 2>/dev/null; then \
			echo "stopping pid $$pid (from $(PID))"; \
			kill -TERM $$pid 2>/dev/null || true; \
			for _ in 1 2 3 4 5; do kill -0 $$pid 2>/dev/null || break; sleep 1; done; \
			kill -0 $$pid 2>/dev/null && kill -KILL $$pid; \
			stopped=1; \
		fi; \
		rm -f $(PID); \
	fi; \
	for stale in $$(pgrep -x shruti-mcp); do \
		echo "stopping stale pid $$stale (shruti-mcp)"; \
		kill -TERM $$stale 2>/dev/null || true; \
		for _ in 1 2 3 4 5; do kill -0 $$stale 2>/dev/null || break; sleep 1; done; \
		kill -0 $$stale 2>/dev/null && kill -KILL $$stale; \
		stopped=1; \
	done; \
	[ $$stopped -eq 0 ] && echo "shruti-mcp: nothing to stop" || true

restart: down up

status:
	@printf "shruti-mcp: "
	@if [ -f $(PID) ] && kill -0 $$(cat $(PID)) 2>/dev/null; then \
		echo "running (pid $$(cat $(PID)), addr=$(ADDR))"; \
	else \
		echo "stopped"; \
	fi

logs:
	@tail -n 100 -F $(LOG)
