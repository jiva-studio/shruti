# Lectorium share-transcript service (Python / FastAPI).
# Built from the workspace `modules/` context (matches chat/auth/share-*).

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid 1000 share && \
    useradd  --uid 1000 --gid 1000 --no-create-home --shell /usr/sbin/nologin share

WORKDIR /app

# Stage 1 — install deps. Cached unless pyproject.toml changes.
COPY services/share-transcript/app/pyproject.toml /app/pyproject.toml
RUN mkdir -p /app/src/share_transcript && \
    echo '__version__ = "0.0.0"' > /app/src/share_transcript/__init__.py
RUN pip install --upgrade pip && pip install .

# Stage 2 — copy actual source (incl. bundled fonts). Fast layer.
COPY services/share-transcript/app/src /app/src
RUN pip install --no-deps -e .

RUN chown -R share:share /app
USER share

# Build stamps surfaced on /healthz — CI passes both as --build-arg.
ARG LECTORIUM_BUILD_SHA=dev
ARG LECTORIUM_BUILD_TIME=dev
ENV LECTORIUM_BUILD_SHA=$LECTORIUM_BUILD_SHA \
    LECTORIUM_BUILD_TIME=$LECTORIUM_BUILD_TIME

EXPOSE 8084

CMD ["uvicorn", "share_transcript.main:app", "--host", "0.0.0.0", "--port", "8084"]
