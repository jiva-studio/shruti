# Turnkey runner for the native Android suite. From this directory:
#
#   make install                          # one-time: npm deps
#   make emulator                         # boot the AVD (port 5556)
#   make build                            # catalog + APK, pointed at the mock
#   make test                             # whole suite
#   make test SPEC=specs/cold-start.spec.ts
#   make clock-reset                      # after a killed date spec
#
# `test` needs a built APK and a booted emulator; it starts the mock server
# and wires `adb reverse` itself. Rebuild after ANY app change — the suite
# installs whatever APK is on disk and never builds one.

.PHONY: install emulator build test clock-reset

SERIAL ?= emulator-5556
SPEC ?=

install:
	npm install

emulator:
	@ANDROID_SERIAL=$(SERIAL) ./scripts/emulator-up.sh

build:
	@./scripts/build-apk.sh

test:
	@ANDROID_SERIAL=$(SERIAL) ./scripts/run.sh $(if $(SPEC),--spec $(SPEC),)

# The date specs move the device clock through the Clock port and put it back
# in `after`. A run killed in between leaves a fake date behind, and every
# later spec then dates its data wrong.
clock-reset:
	@adb -s $(SERIAL) shell su 0 date -u $$(date -u +%m%d%H%M%Y.%S)
	@echo "[clock] $(SERIAL) back on host time"
