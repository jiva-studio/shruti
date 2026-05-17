"""Infrastructure adapters — concrete implementations of domain ports.

Each subpackage groups adapters by the backing technology:
- `repositories/` — read/write against Postgres + SQLite
- (future) `llm/` — LiteLLM-backed LLM provider
- (future) `outline_cache/`, `rate_limit/` — etc.
"""
