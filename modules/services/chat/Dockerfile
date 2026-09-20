# Digest-pinned: the floating `python:3.12-slim` tag moves under us, so two
# builds of the same commit could sit on different interpreters and system
# libraries. Refresh with:
#   docker buildx imagetools inspect python:3.12-slim --format '{{.Manifest.Digest}}'
FROM python:3.12-slim@sha256:229a2c5bfa27522db7815ea81f9bed70af17ccb9de9fc7ad142b1877b5830d36

# uv drives the locked install below. Pinned by version AND digest for the
# same reason the base image is.
COPY --from=ghcr.io/astral-sh/uv:0.11.29@sha256:eb2843a1e56fd9e30c7276ce1a52cba86e64c7b385f5e3279a0e08e02dd058fc /uv /usr/local/bin/uv

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    UV_PYTHON=python3.12 \
    UV_PYTHON_DOWNLOADS=never \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

ENV PATH=/app/.venv/bin:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Non-root runtime user. Created before WORKDIR/COPY so file ownership
# is correct from the start instead of needing a recursive chown later.
RUN groupadd --gid 1000 chat && \
    useradd  --uid 1000 --gid 1000 --no-create-home --shell /usr/sbin/nologin chat

WORKDIR /app

# Stage 1 — locked dependency install. Cached unless pyproject.toml or
# uv.lock changes.
#
# `--frozen` installs exactly the versions (and hashes) uv.lock pins and
# never re-resolves, so rebuilding a commit reproduces its dependency tree
# instead of picking up whatever PyPI published since. Every dep here is a
# floating `>=`, so under the old `pip install .` two builds of one commit
# could differ — that is how the langfuse 3.15 signature change reached prod
# without a red build. `--no-install-project` keeps the source COPY below
# from busting this layer.
#
# CI installs from the same lock with the same command
# (.github/workflows/services-chat-tests.yml and services-ghcr.yml). Keep
# the three in sync: the whole point is that CI proves the tree the image
# ships.
COPY services/chat/app/pyproject.toml services/chat/app/uv.lock services/chat/app/.python-version /app/
RUN uv sync --frozen --no-install-project

# Stage 2 — copy actual source. Fast layer. The project itself stays an
# editable install (as it was with `pip install --no-deps -e .`) because the
# agent prompts are `.md` files loaded via `Path(__file__).parent`.
COPY services/chat/app/src /app/src
RUN uv sync --frozen

# Stage 3 — bundled help corpus (single source of truth: modules/docs/help/).
COPY docs/help /app/docs/help

# Catalog dir is bind-mounted via compose volume but ensure path exists
# and is writable by the runtime user even without the volume (e.g. CI).
RUN mkdir -p /var/lib/chat && chown chat:chat /var/lib/chat /app

USER chat

# Build stamps surfaced on /healthz — CI passes both as --build-arg.
ARG SHRUTI_BUILD_SHA=dev
ARG SHRUTI_BUILD_TIME=dev
ENV SHRUTI_BUILD_SHA=$SHRUTI_BUILD_SHA \
    SHRUTI_BUILD_TIME=$SHRUTI_BUILD_TIME

EXPOSE 8080

# --timeout-graceful-shutdown: uvicorn drains open connections BEFORE running
# the lifespan shutdown, and the lifespan shutdown is the only thing that
# cancels detached turn producers (main.py: turn_runner.shutdown()). Without a
# window the two wait on each other until Docker's SIGKILL, and the teardown
# never runs: quota refunds, idempotency releases, the turn buffer's finish()
# and the Langfuse flush are all skipped. Watchtower redeploys on every push,
# so that was every deploy. Pair with `stop_grace_period` in compose, which
# must be the larger of the two.
CMD ["uvicorn", "shruti_chat.main:app", "--host", "0.0.0.0", "--port", "8080", \
     "--timeout-graceful-shutdown", "30"]
