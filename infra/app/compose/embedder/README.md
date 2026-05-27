# lectorium-embedder

HuggingFace [text-embeddings-inference](https://github.com/huggingface/text-embeddings-inference)
serving `BAAI/bge-m3` (1024-dim, multilingual). Exposes an
OpenAI-compatible `/v1/embeddings` endpoint on port 8080 inside the
lectorium docker network.

## Why this image exists

Chat needs an embedding backend per region. EU runs against OpenAI
cloud (text-embedding-3-small, 1536 dim) which works fine. RU's Yandex
Foundation Models embedder throttles at ~10 RPS — the indexer can't
clear the corpus through that. Self-hosting BGE-M3 removes the rate
limit and the per-call cost.

The model is baked into the image (~2.3 GB of weights on top of the
~600 MB TEI base → final image ~3 GB) so the runtime container starts
without phoning home to huggingface.co. That matters because RU's
egress to huggingface.co is unreliable; baking dodges the problem by
doing the download on a GitHub Actions runner with unrestricted access.

## Opt-in via compose profile

The service is gated behind `profiles: ["selfhosted-embedder"]` in
`infra/app/compose/docker-compose.yml`. Only regions that set
`COMPOSE_PROFILES=selfhosted-embedder` in `/opt/lectorium/.env` will
spawn it. EU leaves the profile inactive and the container is never
created.

## Bumping the model

1. Update the `huggingface-cli download <new-model>` line in
   `Dockerfile`.
2. Update `--model-id=<new-model>` in `docker-compose.yml`.
3. Update `EMBED_MODEL` and `EMBED_DIM` on the RU host's `.env` to
   match the new model. The Postgres per-dim tables already exist for
   256 / 768 / 1024 / 1536 (migration 0030). For dims outside that
   set, add a new per-dim table in a fresh migration.
4. The next indexer run re-embeds the whole corpus against the new
   `embed_model` name (the dedup query keys on the name) — expect
   another ~45-90 min reindex window on RU.

## Sizing

| | |
|---|---|
| Image size | ~3 GB |
| Model RAM resident | ~3 GB |
| CPU throughput | ~30-60 doc/s on 4 vCPU EPYC |
| Full corpus reindex | ~45-90 min for ~165k chunks |
| Query latency (interactive) | ~50-150 ms per single-doc call |
