.PHONY: help mobile mobile-install db-sync
.PHONY: mobile-build mobile-build-bundled mobile-deploy mobile-live
.PHONY: mobile-build-ios mobile-upload-ios
.PHONY: mobile-screenshots mobile-screenshots-android mobile-screenshots-ios
.PHONY: worktree-create worktree-serve worktree-serve-bg worktree-list worktree-remove
.PHONY: transcriber-build transcriber-up transcriber-down transcriber-restart transcriber-status transcriber-logs
.PHONY: transcriber-service-build transcriber-service-up transcriber-service-down transcriber-service-restart transcriber-service-status transcriber-service-logs
.PHONY: transcriber-mcp-build transcriber-mcp-up transcriber-mcp-down transcriber-mcp-restart transcriber-mcp-status transcriber-mcp-logs
.PHONY: lectorium-mcp-build lectorium-mcp-test lectorium-mcp-lint lectorium-mcp-up lectorium-mcp-down lectorium-mcp-restart lectorium-mcp-status lectorium-mcp-logs
.PHONY: stack-setup stack-up stack-down stack-restart stack-status stack-logs stack-app
.PHONY: e2e-install e2e e2e-all e2e-report
.PHONY: native-install native-emulator native-build native native-clock-reset
.PHONY: mutate-diff mutate-full

# --- Mutation testing ---

mutate-diff: ## Run diff mutation testing against merge base with main (pass PKG=mobile, default: mobile)
	@./scripts/lectorium-run-alone "mutation testing" ./scripts/lectorium-mutation-suite-run diff $(or $(PKG),mobile)

mutate-full: ## Run full mutation testing across package (pass PKG=mobile, default: mobile)
	@./scripts/lectorium-run-alone "mutation testing" ./scripts/lectorium-mutation-suite-run full $(or $(PKG),mobile)


# --- Variables ---
ISSUE ?= 0
WORKTREE_BASE := $(shell cd .. && pwd)/.worktrees
WORKTREE_DIR = $(WORKTREE_BASE)/issue-$(ISSUE)
WORKTREE_PORT = $(shell echo $$((11100 + $(ISSUE))))
BRANCH_NAME = $(or $(BRANCH),feature/$(ISSUE))
LOG = @echo "[$(1)]"

help: ## Show available commands
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  make %-32s %s\n", $$1, $$2}'

mobile-install: ## Install mobile app npm dependencies (first-time setup)
	@cd modules/apps/mobile && npm install

mobile: ## Run mobile app in browser (port 11001)
	cd modules/apps/mobile && npm run dev

db-sync: ## Sync bundled content DB into android/ios/e2e (pass TARGET=android|ios|e2e|all, default: all)
	@bash modules/db-sync.sh $(or $(TARGET),all)

# --- Android build & deploy ---

APK_PATH = modules/apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk

mobile-build: ## Build debug APK for Android (via Fastlane)
	@cd modules/apps/mobile && bundle exec fastlane android build_debug
	@echo "[build-apk] Done: $(APK_PATH)"
	@ls -lh $(APK_PATH) | awk '{print "[build-apk] Size: " $$5}'

mobile-build-bundled: mobile-build ## Alias: Fastlane build_debug already bundles production DB

# --- iOS build & deploy (requires macOS + configured Apple Developer creds) ---

IPA_PATH = modules/apps/mobile/ios/App/build/App.ipa

mobile-build-ios: ## Build signed release IPA (requires APPLE_* env vars or .env)
	@cd modules/apps/mobile && bundle exec fastlane ios build
	@echo "[build-ipa] Done: $(IPA_PATH)"
	@ls -lh $(IPA_PATH) | awk '{print "[build-ipa] Size: " $$5}'

mobile-upload-ios: ## Upload existing IPA to TestFlight (pass IPA=path to override)
	@cd modules/apps/mobile && bundle exec fastlane ios upload \
		$(if $(IPA),ipa:$(IPA),)

mobile-screenshots-android: ## Generate + upload Google Play screenshots (pass SKIP_UPLOAD=1 to stop before upload)
	@cd modules/apps/mobile && bundle exec fastlane android screenshots \
		$(if $(SKIP_UPLOAD),skip_upload:true,) \
		$(if $(SKIP_GENERATE),skip_generate:true,) \
		$(if $(SKIP_CAPTURE),skip_capture:true,) \
		$(if $(SKIP_FRAME),skip_frame:true,) \
		$(if $(LOCALES),locales:$(LOCALES),)

# Back-compat alias — existing docs/scripts call `make mobile-screenshots`.
mobile-screenshots: mobile-screenshots-android ## Alias for mobile-screenshots-android

mobile-screenshots-ios: ## Generate + upload App Store Connect screenshots (iPhone 6.7" + iPad 13")
	@cd modules/apps/mobile && bundle exec fastlane ios screenshots \
		$(if $(SKIP_UPLOAD),skip_upload:true,) \
		$(if $(SKIP_GENERATE),skip_generate:true,) \
		$(if $(SKIP_CAPTURE),skip_capture:true,) \
		$(if $(SKIP_FRAME),skip_frame:true,) \
		$(if $(LOCALES),locales:$(LOCALES),)

mobile-deploy: mobile-build ## Build debug APK and install on connected device
	@echo "[deploy] Installing on device..."
	@adb start-server >/dev/null 2>&1; \
	DEVICE=$$(adb devices | awk '$$2=="device"{print $$1; exit}'); \
	if [ -z "$$DEVICE" ]; then \
		echo "[deploy] ERROR: no device connected. Run 'adb devices' to check."; \
		exit 1; \
	fi; \
	echo "[deploy] Device: $$DEVICE"; \
	adb -s $$DEVICE shell settings put global verifier_verify_adb_installs 0 || exit 1; \
	adb -s $$DEVICE shell settings put secure install_non_market_apps 1 || exit 1; \
	adb -s $$DEVICE push $(APK_PATH) /data/local/tmp/app-debug.apk || exit 1; \
	installed=0; \
	for i in 1 2 3; do \
		echo "[deploy] Attempt $$i..."; \
		if adb -s $$DEVICE shell pm install -i com.android.vending -r -t /data/local/tmp/app-debug.apk; then \
			installed=1; break; \
		fi; \
		sleep 1; \
	done; \
	if [ "$$installed" = "0" ]; then \
		echo "[deploy] ERROR: install failed after 3 attempts."; \
		exit 1; \
	fi; \
	echo "[deploy] Done!"

mobile-live: ## Live reload on device: make mobile-live ISSUE=42
	@if [ "$(ISSUE)" = "0" ]; then \
		echo "[mobile-live] ERROR: ISSUE is required. Usage: make mobile-live ISSUE=42"; \
		exit 1; \
	fi
	@adb start-server >/dev/null 2>&1; \
	HOST_IP=$$(hostname -I | awk '{print $$1}'); \
	PORT=$(WORKTREE_PORT); \
	DEVICE=$$(adb devices | awk '$$2=="device"{print $$1; exit}'); \
	if [ -z "$$DEVICE" ]; then \
		echo "[mobile-live] ERROR: no device connected. Run 'adb devices' to check."; \
		exit 1; \
	fi; \
	echo "[mobile-live] Device: $$DEVICE"; \
	echo "[mobile-live] Server: http://$$HOST_IP:$$PORT"; \
	echo "[mobile-live] Syncing with live reload URL..."; \
	cd $(WORKTREE_DIR)/modules/apps/mobile && \
	CAPACITOR_SERVER_URL=http://$$HOST_IP:$$PORT npx cap sync android && \
	echo "[mobile-live] Building APK..." && \
	cd android && ./gradlew assembleDebug && cd .. && \
	echo "[mobile-live] Installing on device..." && \
	adb -s $$DEVICE shell settings put global verifier_verify_adb_installs 0 && \
	adb -s $$DEVICE shell settings put secure install_non_market_apps 1 && \
	adb -s $$DEVICE push android/app/build/outputs/apk/debug/app-debug.apk /data/local/tmp/app-debug.apk && \
	installed=0; \
	for i in 1 2 3; do \
		echo "[mobile-live] Install attempt $$i..."; \
		if adb -s $$DEVICE shell pm install -i com.android.vending -r -t /data/local/tmp/app-debug.apk; then \
			installed=1; break; \
		fi; \
		sleep 1; \
	done; \
	if [ "$$installed" = "0" ]; then \
		echo "[mobile-live] ERROR: install failed after 3 attempts."; \
		exit 1; \
	fi; \
	echo "[mobile-live] Starting dev server on port $$PORT..." && \
	VITE_PORT=$$PORT npm run dev

# --- Worktree management ---

worktree-create: ## Create worktree for issue: make worktree-create ISSUE=42
	@if [ "$(ISSUE)" = "0" ]; then \
		echo "[worktree-create] ERROR: ISSUE is required. Usage: make worktree-create ISSUE=42"; \
		exit 1; \
	fi
	@if [ -d "$(WORKTREE_DIR)" ]; then \
		echo "[worktree-create] ERROR: Worktree already exists at $(WORKTREE_DIR)"; \
		exit 1; \
	fi
	@echo "[worktree-create] Creating worktree for issue #$(ISSUE)..."
	@echo "[worktree-create] Branch: $(BRANCH_NAME)"
	@echo "[worktree-create] Path:   $(WORKTREE_DIR)"
	@mkdir -p $(WORKTREE_BASE)
	@if git show-ref --verify --quiet refs/heads/$(BRANCH_NAME) 2>/dev/null; then \
		echo "[worktree-create] Branch $(BRANCH_NAME) exists, checking out..."; \
		git worktree add $(WORKTREE_DIR) $(BRANCH_NAME); \
	else \
		echo "[worktree-create] Creating new branch $(BRANCH_NAME)..."; \
		git worktree add -b $(BRANCH_NAME) $(WORKTREE_DIR) main; \
	fi
	@echo "[worktree-create] Installing dependencies..."
	@cd $(WORKTREE_DIR)/modules/apps/mobile && npm ci --silent
	@echo "[worktree-create]"
	@echo "[worktree-create] Summary:"
	@echo "[worktree-create]   Issue:  #$(ISSUE)"
	@echo "[worktree-create]   Branch: $(BRANCH_NAME)"
	@echo "[worktree-create]   Path:   $(WORKTREE_DIR)"
	@echo "[worktree-create]   Port:   $(WORKTREE_PORT)"
	@echo "[worktree-create]   URL:    http://localhost:$(WORKTREE_PORT)"
	@echo "[worktree-create]"
	@echo "[worktree-create] Next: make worktree-serve ISSUE=$(ISSUE)"

worktree-serve: ## Start dev server for issue: make worktree-serve ISSUE=42
	@if [ "$(ISSUE)" = "0" ]; then \
		echo "[worktree-serve] ERROR: ISSUE is required. Usage: make worktree-serve ISSUE=42"; \
		exit 1; \
	fi
	@if [ ! -d "$(WORKTREE_DIR)" ]; then \
		echo "[worktree-serve] ERROR: Worktree not found at $(WORKTREE_DIR). Run: make worktree-create ISSUE=$(ISSUE)"; \
		exit 1; \
	fi
	@echo "[worktree-serve] Starting dev server for issue #$(ISSUE)..."
	@echo "[worktree-serve] Port: $(WORKTREE_PORT)"
	@echo "[worktree-serve] URL:  http://localhost:$(WORKTREE_PORT)"
	@echo "[worktree-serve] Path: $(WORKTREE_DIR)/modules/apps/mobile"
	cd $(WORKTREE_DIR)/modules/apps/mobile && VITE_PORT=$(WORKTREE_PORT) npm run dev

worktree-serve-bg: ## Start dev server in background: make worktree-serve-bg ISSUE=42
	@if [ "$(ISSUE)" = "0" ]; then \
		echo "[worktree-serve-bg] ERROR: ISSUE is required. Usage: make worktree-serve-bg ISSUE=42"; \
		exit 1; \
	fi
	@if [ ! -d "$(WORKTREE_DIR)" ]; then \
		echo "[worktree-serve-bg] ERROR: Worktree not found at $(WORKTREE_DIR). Run: make worktree-create ISSUE=$(ISSUE)"; \
		exit 1; \
	fi
	@echo "[worktree-serve-bg] Starting dev server for issue #$(ISSUE) (background)..."
	@echo "[worktree-serve-bg] Port: $(WORKTREE_PORT)"
	@echo "[worktree-serve-bg] URL:  http://localhost:$(WORKTREE_PORT)"
	@echo "[worktree-serve-bg] Path: $(WORKTREE_DIR)/modules/apps/mobile"
	@echo "[worktree-serve-bg] Log:  /tmp/lectorium-worktree-$(ISSUE).log"
	@cd $(WORKTREE_DIR)/modules/apps/mobile && VITE_PORT=$(WORKTREE_PORT) nohup npm run dev > /tmp/lectorium-worktree-$(ISSUE).log 2>&1 &
	@echo "[worktree-serve-bg] Server started in background."

worktree-list: ## List all active worktrees with ports
	@echo "[worktree-list] Active worktrees:"
	@echo "[worktree-list]"
	@found=0; \
	for dir in $(WORKTREE_BASE)/issue-*; do \
		if [ -d "$$dir" ]; then \
			found=1; \
			num=$$(basename $$dir | sed 's/issue-//'); \
			port=$$((11100 + num)); \
			branch=$$(git -C $$dir branch --show-current 2>/dev/null || echo "unknown"); \
			echo "[worktree-list]   #$$num  port:$$port  branch:$$branch  path:$$dir"; \
		fi; \
	done; \
	if [ "$$found" = "0" ]; then \
		echo "[worktree-list]   (none)"; \
	fi
	@echo "[worktree-list]"
	@echo "[worktree-list] Main: port:11001  branch:$$(git branch --show-current)  path:$$(pwd)"

worktree-remove: ## Remove worktree for issue: make worktree-remove ISSUE=42
	@if [ "$(ISSUE)" = "0" ]; then \
		echo "[worktree-remove] ERROR: ISSUE is required. Usage: make worktree-remove ISSUE=42"; \
		exit 1; \
	fi
	@if [ ! -d "$(WORKTREE_DIR)" ]; then \
		echo "[worktree-remove] ERROR: Worktree not found at $(WORKTREE_DIR)"; \
		exit 1; \
	fi
	@echo "[worktree-remove] Removing worktree for issue #$(ISSUE)..."
	@echo "[worktree-remove] Path: $(WORKTREE_DIR)"
	@branch=$$(git -C $(WORKTREE_DIR) branch --show-current 2>/dev/null || echo "unknown"); \
	git worktree remove $(WORKTREE_DIR) --force; \
	echo "[worktree-remove] Worktree removed."; \
	echo "[worktree-remove] Note: branch $$branch kept (delete manually: git branch -d $$branch)"

# --- Lectorium services: transcriber stack (delegates to modules/tools/Makefile) ---

transcriber-build: ## Build transcriber service + MCP wrapper binaries
	@$(MAKE) -C modules/tools transcriber-build

transcriber-up: ## Start transcriber service + MCP wrapper
	@$(MAKE) -C modules/tools transcriber-up

transcriber-down: ## Stop transcriber service + MCP wrapper
	@$(MAKE) -C modules/tools transcriber-down

transcriber-restart: ## Restart transcriber service + MCP wrapper
	@$(MAKE) -C modules/tools transcriber-restart

transcriber-status: ## Show transcriber service + MCP wrapper status (pids + healthz)
	@$(MAKE) -C modules/tools transcriber-status

transcriber-logs: ## Tail logs for transcriber service + MCP wrapper
	@$(MAKE) -C modules/tools transcriber-logs

transcriber-service-build: ## Build only the transcriber HTTP service
	@$(MAKE) -C modules/tools transcriber-service-build

transcriber-service-up: ## Start only the transcriber HTTP service
	@$(MAKE) -C modules/tools transcriber-service-up

transcriber-service-down: ## Stop only the transcriber HTTP service
	@$(MAKE) -C modules/tools transcriber-service-down

transcriber-service-restart: ## Restart only the transcriber HTTP service
	@$(MAKE) -C modules/tools transcriber-service-restart

transcriber-service-status: ## Show status of the transcriber HTTP service
	@$(MAKE) -C modules/tools transcriber-service-status

transcriber-service-logs: ## Tail logs of the transcriber HTTP service
	@$(MAKE) -C modules/tools transcriber-service-logs

transcriber-mcp-build: ## Build only the transcriber MCP wrapper
	@$(MAKE) -C modules/tools transcriber-mcp-build

transcriber-mcp-up: ## Start only the transcriber MCP wrapper
	@$(MAKE) -C modules/tools transcriber-mcp-up

transcriber-mcp-down: ## Stop only the transcriber MCP wrapper
	@$(MAKE) -C modules/tools transcriber-mcp-down

transcriber-mcp-restart: ## Restart only the transcriber MCP wrapper
	@$(MAKE) -C modules/tools transcriber-mcp-restart

transcriber-mcp-status: ## Show status of the transcriber MCP wrapper
	@$(MAKE) -C modules/tools transcriber-mcp-status

transcriber-mcp-logs: ## Tail logs of the transcriber MCP wrapper
	@$(MAKE) -C modules/tools transcriber-mcp-logs

# --- Lectorium services: lectorium-mcp daemon (delegates to modules/tools/lectorium-mcp/Makefile) ---

lectorium-mcp-build: ## Build the lectorium-mcp binary
	@$(MAKE) -C modules/tools/lectorium-mcp build

lectorium-mcp-test: ## Run lectorium-mcp unit tests
	@$(MAKE) -C modules/tools/lectorium-mcp test

lectorium-mcp-lint: ## Run staticcheck on lectorium-mcp
	@$(MAKE) -C modules/tools/lectorium-mcp lint

lectorium-mcp-up: ## Start lectorium-mcp daemon
	@$(MAKE) -C modules/tools/lectorium-mcp up

lectorium-mcp-down: ## Stop lectorium-mcp daemon
	@$(MAKE) -C modules/tools/lectorium-mcp down

lectorium-mcp-restart: ## Restart lectorium-mcp daemon
	@$(MAKE) -C modules/tools/lectorium-mcp restart

lectorium-mcp-status: ## Show lectorium-mcp daemon status
	@$(MAKE) -C modules/tools/lectorium-mcp status

lectorium-mcp-logs: ## Tail lectorium-mcp daemon logs
	@$(MAKE) -C modules/tools/lectorium-mcp logs

# --- Local backend stack (infra/app/compose/docker-compose.dev.yml:
#     postgres + redis + chat + auth + cleanup-worker). Project name
#     `lectorium`, `origin` profile, host ports in the 11xxx band. ---

# Canonical compose invocation, run from infra/app/compose. Reused by every
# stack-* target so the project name / profile / file set / env file stay in
# one place.
STACK_COMPOSE = COMPOSE_PROFILES=origin docker compose -p lectorium -f docker-compose.yml -f docker-compose.dev.yml --env-file ../.env.dev

stack-setup: ## First-time local setup: generate .env.dev + JWT keys + npm install
	@infra/app/scripts/gen-dev-env.sh
	@infra/app/scripts/gen-jwt-keys.sh
	@$(MAKE) mobile-install

stack-up: ## Start the local stack (builds all services from source; chat 11080, auth 11081, pg 11082, redis 11083, share-audio 11084)
	@cd infra/app/compose && $(STACK_COMPOSE) up -d

stack-down: ## Stop local backend stack (keeps pg/redis volumes; add -v by hand to wipe)
	@cd infra/app/compose && $(STACK_COMPOSE) down

stack-restart: ## Restart local backend stack
	@cd infra/app/compose && $(STACK_COMPOSE) restart

stack-status: ## Show local backend stack containers + chat readiness
	@cd infra/app/compose && $(STACK_COMPOSE) ps
	@curl -fsS http://localhost:11080/readyz && echo || echo "chat not ready (stack down or still indexing)"

stack-logs: ## Tail local backend stack logs (Ctrl-C to stop)
	@cd infra/app/compose && $(STACK_COMPOSE) logs -f

stack-app: ## Serve the mobile app against the local stack (dev region, port 11001)
	@cd modules/apps/mobile && VITE_DEV_REGION=true npm run dev

e2e-install: ## One-time mobile E2E setup (deps + chromium + fixtures)
	@$(MAKE) -C tests/e2e/mobile install

e2e: ## Run the mobile E2E suite, offline only (fast, no backend)
	@$(MAKE) -C tests/e2e/mobile test

e2e-all: ## Run the full mobile E2E suite (offline + live; auto-starts the stack)
	@$(MAKE) -C tests/e2e/mobile all

e2e-report: ## Open the mobile E2E HTML report (a video per test)
	@$(MAKE) -C tests/e2e/mobile report

native-install: ## One-time native Android suite setup (npm deps)
	@$(MAKE) -C tests/native/android install

native-emulator: ## Boot the emulator the native suite drives (port 5556)
	@$(MAKE) -C tests/native/android emulator

native-build: ## Build the APK the native suite installs (catalog bundled, mock region)
	@$(MAKE) -C tests/native/android build

native: ## Run the native Android suite on the emulator (pass SPEC=specs/x.spec.ts for one)
	@$(MAKE) -C tests/native/android test SPEC=$(SPEC)

native-clock-reset: ## Put the emulator clock back after a killed date spec
	@$(MAKE) -C tests/native/android clock-reset
