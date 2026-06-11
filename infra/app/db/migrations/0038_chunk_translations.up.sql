-- Persistent cache for LLM-translated verbatim citations (opt-in
-- `translate_citations`). The chat service ships transcript / verse /
-- commentary / media text to the client VERBATIM; when the answer
-- language has no native corpus variant and the user opted in, we
-- machine-translate the prose once and reuse it for every user.
--
-- The cache key is (content_hash, language, model, prompt_version):
--   * content_hash   — blake2b-12 hex of the SOURCE text (stable id, no
--                      need to store the often-large source string)
--   * language       — target locale; Serbian normalises to `sr-Latn`
--                      (the `sr-Cyrl` rendering is derived by deterministic
--                      transliteration on output, so it shares one row)
--   * model          — translator model id; changing it mints fresh rows,
--                      old ones survive (re-warm in the background)
--   * prompt_version — translator prompt revision; same rotation property
--
-- A pure data table (no embedding column, no large index): a small TEXT
-- PK. The create is fast and lock-light; cap lock_timeout defensively
-- like 0030 / 0032.
SET lock_timeout = '30s';

CREATE TABLE IF NOT EXISTS chunk_translations (
    content_hash    TEXT        NOT NULL,
    language        TEXT        NOT NULL,
    model           TEXT        NOT NULL,
    prompt_version  TEXT        NOT NULL,
    translated_text TEXT        NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (content_hash, language, model, prompt_version)
);
