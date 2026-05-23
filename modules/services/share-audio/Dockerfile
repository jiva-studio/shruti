# Lectorium share-audio service.
# Built from the workspace `modules/` context (matches auth/chat).

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# ffmpeg for the actual cut; curl for the compose healthcheck.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Non-root runtime user. Created up front so file ownership lands correctly.
RUN groupadd --gid 1000 share && \
    useradd  --uid 1000 --gid 1000 --no-create-home --shell /usr/sbin/nologin share

WORKDIR /app

# Install deps (cached unless requirements.txt changes).
COPY services/share-audio/requirements.txt /app/requirements.txt
RUN pip install --upgrade pip && pip install -r /app/requirements.txt

# Source code. storage.py + the new app/ package live side-by-side; the
# app imports `storage` as a top-level module, hence the flat /app layout.
COPY services/share-audio/storage.py  /app/storage.py
COPY services/share-audio/app/        /app/app/

RUN chown -R share:share /app

USER share

EXPOSE 8082

# 4 uvicorn workers → 4 concurrent ffmpeg cuts. Each cut is <1s wallclock,
# stream-copy only, so this comfortably absorbs CGNAT-spike traffic
# behind the per-IP Caddy rate-limit (60/min/IP).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8082", "--workers", "4"]
