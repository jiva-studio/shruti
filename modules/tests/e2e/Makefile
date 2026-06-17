# Turnkey runner for the mobile E2E suite. From this directory:
#
#   make install     # one-time: deps + browser + fixtures
#   make test        # offline suite (fast, no backend)
#   make live        # live suite (brings the stack up if needed)
#   make all         # offline + live, into one report
#   make report      # open the HTML report (video per test)
#   make stack       # just bring the local backend stack up
#
# `all`/`live` auto-start the local stack (postgres+redis+chat+auth) and serve
# the live app from a CORS-whitelisted origin (:8080). See README.

.PHONY: install test live all report stack fixtures

install:
	npm install
	npx playwright install chromium
	./scripts/prepare-fixtures.sh

fixtures:
	./scripts/prepare-fixtures.sh

test:
	npm run test:offline

live: stack
	npm run test:live

all:
	./scripts/run-all.sh

stack:
	./scripts/live-up.sh

report:
	npm run report
