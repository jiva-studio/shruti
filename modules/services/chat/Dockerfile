FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

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

RUN mkdir -p /var/lib/chat

EXPOSE 8080

CMD ["uvicorn", "shruti_chat.main:app", "--host", "0.0.0.0", "--port", "8080"]
