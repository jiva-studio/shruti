FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Non-root runtime user. Created before WORKDIR/COPY so file ownership
# is correct from the start instead of needing a recursive chown later.
RUN groupadd --gid 1000 chat && \
    useradd  --uid 1000 --gid 1000 --no-create-home --shell /usr/sbin/nologin chat

WORKDIR /app

# Stage 1 — install deps. Cached unless pyproject.toml changes.
COPY services/chat/app/pyproject.toml /app/pyproject.toml
RUN mkdir -p /app/src/lectorium_chat && \
    echo '__version__ = "0.0.0"' > /app/src/lectorium_chat/__init__.py
RUN pip install --upgrade pip && pip install .

# Stage 2 — copy actual source. Fast layer.
COPY services/chat/app/src /app/src
RUN pip install --no-deps -e .

# Stage 3 — bundled help corpus (single source of truth: modules/docs/help/).
COPY docs/help /app/docs/help

# Catalog dir is bind-mounted via compose volume but ensure path exists
# and is writable by the runtime user even without the volume (e.g. CI).
RUN mkdir -p /var/lib/chat && chown chat:chat /var/lib/chat /app

USER chat

# Build stamps surfaced on /healthz — CI passes both as --build-arg.
ARG LECTORIUM_BUILD_SHA=dev
ARG LECTORIUM_BUILD_TIME=dev
ENV LECTORIUM_BUILD_SHA=$LECTORIUM_BUILD_SHA \
    LECTORIUM_BUILD_TIME=$LECTORIUM_BUILD_TIME

EXPOSE 8080

# --timeout-graceful-shutdown: uvicorn drains open connections BEFORE running
# the lifespan shutdown, and the lifespan shutdown is the only thing that
# cancels detached turn producers (main.py: turn_runner.shutdown()). Without a
# window the two wait on each other until Docker's SIGKILL, and the teardown
# never runs: quota refunds, idempotency releases, the turn buffer's finish()
# and the Langfuse flush are all skipped. Watchtower redeploys on every push,
# so that was every deploy. Pair with `stop_grace_period` in compose, which
# must be the larger of the two.
CMD ["uvicorn", "lectorium_chat.main:app", "--host", "0.0.0.0", "--port", "8080", \
     "--timeout-graceful-shutdown", "30"]
