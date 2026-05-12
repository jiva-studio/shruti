# Orchestrator for the transcriber stack: HTTP service + MCP wrapper running side
# by side on a dev machine. For production use launchd (deferred).
#
# Bulk targets (act on both):
#   transcriber-build         — build both binaries
#   transcriber-up            — start both in the background
#   transcriber-down          — stop both
#   transcriber-restart       — down + up
#   transcriber-status        — current PIDs + healthz for both
#   transcriber-logs          — tail logs of both
#
# Per-service targets (act on one):
#   transcriber-service-build / -up / -down / -restart / -status / -logs
#   transcriber-mcp-build     / -up / -down / -restart / -status / -logs

.PHONY: transcriber-build transcriber-up transcriber-down transcriber-restart \
        transcriber-status transcriber-logs \
        transcriber-service-build transcriber-service-up transcriber-service-down \
        transcriber-service-restart transcriber-service-status transcriber-service-logs \
        transcriber-mcp-build transcriber-mcp-up transcriber-mcp-down \
        transcriber-mcp-restart transcriber-mcp-status transcriber-mcp-logs

SERVICE_DIR := transcriber-service
MCP_DIR     := transcriber-mcp

SERVICE_PID := /tmp/transcriber-service.pid
MCP_PID     := /tmp/transcriber-mcp.pid
SERVICE_LOG := /tmp/transcriber-service.log
MCP_LOG     := /tmp/transcriber-mcp.log

SERVICE_ADDR ?= 0.0.0.0:8080
MCP_ADDR     ?= 0.0.0.0:8090
SERVICE_URL  ?= http://localhost:8080

# --- per-service: transcriber-service ---

transcriber-service-build:
	$(MAKE) -C $(SERVICE_DIR) build

transcriber-service-up: transcriber-service-build
	@if pgrep -f "$(SERVICE_DIR)/bin/transcriber-service " >/dev/null 2>&1 || pgrep -f "./bin/transcriber-service " >/dev/null 2>&1; then \
		echo "transcriber-service already running (pid $$(pgrep -f './bin/transcriber-service ' | head -1))"; \
	else \
		( cd $(SERVICE_DIR) && nohup ./bin/transcriber-service -addr $(SERVICE_ADDR) >$(SERVICE_LOG) 2>&1 & ); \
		sleep 0.5; \
		pgrep -f "./bin/transcriber-service -addr $(SERVICE_ADDR)" | head -1 >$(SERVICE_PID); \
		echo "transcriber-service: started pid $$(cat $(SERVICE_PID)), log=$(SERVICE_LOG)"; \
	fi

transcriber-service-down:
	@$(call _stop_pid,$(SERVICE_PID),./bin/transcriber-service)

transcriber-service-restart: transcriber-service-down transcriber-service-up

transcriber-service-status:
	@printf "transcriber-service: "
	@if [ -f $(SERVICE_PID) ] && kill -0 $$(cat $(SERVICE_PID)) 2>/dev/null; then \
		echo "running (pid $$(cat $(SERVICE_PID)))"; \
		curl -sf http://localhost:8080/healthz | sed 's/^/  /' || true; \
	else \
		echo "stopped"; \
	fi

transcriber-service-logs:
	@tail -n 100 -F $(SERVICE_LOG)

# --- per-service: transcriber-mcp ---

transcriber-mcp-build:
	$(MAKE) -C $(MCP_DIR) build

transcriber-mcp-up: transcriber-mcp-build
	@if pgrep -f "./bin/transcriber-mcp " >/dev/null 2>&1; then \
		echo "transcriber-mcp already running (pid $$(pgrep -f './bin/transcriber-mcp ' | head -1))"; \
	else \
		( cd $(MCP_DIR) && nohup ./bin/transcriber-mcp -addr $(MCP_ADDR) -service-url $(SERVICE_URL) >$(MCP_LOG) 2>&1 & ); \
		sleep 0.5; \
		pgrep -f "./bin/transcriber-mcp -addr $(MCP_ADDR)" | head -1 >$(MCP_PID); \
		echo "transcriber-mcp:    started pid $$(cat $(MCP_PID)), log=$(MCP_LOG)"; \
	fi

transcriber-mcp-down:
	@$(call _stop_pid,$(MCP_PID),./bin/transcriber-mcp)

transcriber-mcp-restart: transcriber-mcp-down transcriber-mcp-up

transcriber-mcp-status:
	@printf "transcriber-mcp:     "
	@if [ -f $(MCP_PID) ] && kill -0 $$(cat $(MCP_PID)) 2>/dev/null; then \
		echo "running (pid $$(cat $(MCP_PID)))"; \
		curl -sf http://localhost:8090/healthz | sed 's/^/  /' || true; \
	else \
		echo "stopped"; \
	fi

transcriber-mcp-logs:
	@tail -n 100 -F $(MCP_LOG)

# --- bulk: both services ---

transcriber-build: transcriber-service-build transcriber-mcp-build

transcriber-up: transcriber-service-up transcriber-mcp-up

transcriber-down: transcriber-service-down transcriber-mcp-down

transcriber-restart: transcriber-down transcriber-up

transcriber-status: transcriber-service-status transcriber-mcp-status

transcriber-logs:
	@tail -n 100 -F $(SERVICE_LOG) $(MCP_LOG)

# --- helper used by both -down targets ---

define _stop_pid
	stopped=0; \
	if [ -f $(1) ]; then \
		pid=$$(cat $(1)); \
		if [ -n "$$pid" ] && kill -0 $$pid 2>/dev/null; then \
			echo "stopping pid $$pid (from $(1))"; \
			kill -TERM $$pid 2>/dev/null || true; \
			for _ in 1 2 3 4 5; do kill -0 $$pid 2>/dev/null || break; sleep 1; done; \
			kill -0 $$pid 2>/dev/null && kill -KILL $$pid; \
			stopped=1; \
		fi; \
		rm -f $(1); \
	fi; \
	for stale in $$(pgrep -f "$(2) "); do \
		echo "stopping stale pid $$stale ($(2))"; \
		kill -TERM $$stale 2>/dev/null || true; \
		for _ in 1 2 3 4 5; do kill -0 $$stale 2>/dev/null || break; sleep 1; done; \
		kill -0 $$stale 2>/dev/null && kill -KILL $$stale; \
		stopped=1; \
	done; \
	[ $$stopped -eq 0 ] && echo "$(2): nothing to stop" || true
endef
