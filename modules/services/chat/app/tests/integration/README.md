# Integration tests — attribution flow

Tests in this directory require a live Postgres with pgvector and an LLM
provider (OpenRouter). They are gated behind the `LECTORIUM_INTEGRATION_DB`
env var so unit-test CI runs stay fast.

## What's covered

`test_attribution_full_flow.py` — three scenarios:

**A. Question-attribution short path:**
1. `library.attribution.create kind=question language=ru text="что такое душа"` via MCP
2. `library.attribution.ref_add` × 3 → БГ 2.13, 2.20, 2.22
3. `library.publish` → S3 artifact
4. Trigger chat-service indexer
5. Assert: `SELECT * FROM attribution_embeddings WHERE attribution_id=…` has rows for ru AND en (auto-translate)
6. `POST /chat` "природа души" lang=ru → SSE includes `[verse:N|...]` markers for all 3 БГ verses
7. Assert log: `pipeline_short_path` fired with stage=native

**B. Topic-attribution long path with boost:**
1. Seed a topic-attribution "вечность души" → refs БГ 2.20, ШБ 7.7.19
2. `POST /chat` "как Прабхупада объяснял неизменность атмана" (deliberately no question match)
3. Assert: `pipeline_long_path` log shows non-empty `boost_ids`
4. Assert response chunks include БГ 2.20 / ШБ 7.7.19 ranked higher than baseline (compare to no-attribution-table run)

**C. Cross-lingual fallback:**
1. Seed question-attribution ONLY on ru: "что такое душа"
2. `POST /chat` "what is the soul" lang=en
3. Assert: short path fires via cross-stage match (`stage="cross"` in log)

## Running locally

```bash
docker compose up -d postgres   # 5432 with pgvector extension
export LECTORIUM_INTEGRATION_DB=postgresql://chat:chat@localhost:5432/chat
export OPENROUTER_API_KEY=...   # for auto-translate + LLM calls
cd modules/services/chat/app
python -m pytest tests/integration/ -v --integration
```

The `--integration` flag (registered in `conftest.py` via `pytest_addoption`)
skips integration tests when absent — `pytest tests/` keeps working
without docker.

## Golden questions fixture

`tests/fixtures/golden_questions.jsonl` lists 25 typical queries with
expected intent + path + minimum chunks. Used by:

- Regression suite: run old vs new pipeline on this set, assert recall
  hasn't dropped (`tests/integration/test_golden_regression.py` — TODO).
- Smoke test: cherry-pick 3-5 entries for fast post-deploy verification.
