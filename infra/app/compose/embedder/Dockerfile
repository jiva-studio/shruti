# Self-hosted text-embeddings server built on HuggingFace TEI with the
# BAAI/bge-m3 weights baked in. Runs the embedding pass for the RU
# region's chat indexer where Yandex's 10 RPS embedding throttle is the
# bottleneck. EU keeps using the OpenAI cloud and never builds against
# this image at runtime (compose profile keeps it inactive).
#
# Two-stage build keeps the final image free of pip / Python tooling we
# only need at build time. The download runs on GitHub Actions, which
# has unrestricted huggingface.co access — RU box never has to reach
# huggingface.co directly.

FROM python:3.11-slim AS downloader

# huggingface_hub CLI for the snapshot download. cache-dir matches the
# HF_HOME layout TEI expects at runtime.
RUN pip install --no-cache-dir 'huggingface_hub[cli]==0.27.0'
RUN huggingface-cli download BAAI/bge-m3 --cache-dir /data

FROM ghcr.io/huggingface/text-embeddings-inference:cpu-1.5

# Resolve BAAI/bge-m3 against the local cache; HF_HUB_OFFLINE prevents
# any phone-home if the cache layout changes between hub client
# versions. Matches the env in docker-compose.yml.
ENV HUGGINGFACE_HUB_CACHE=/data
ENV HF_HUB_OFFLINE=1

COPY --from=downloader /data /data
