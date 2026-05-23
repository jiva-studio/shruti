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
RUN mkdir -p /app/src/shruti_chat && \
    echo '__version__ = "0.0.0"' > /app/src/shruti_chat/__init__.py
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

EXPOSE 8080

CMD ["uvicorn", "shruti_chat.main:app", "--host", "0.0.0.0", "--port", "8080"]
