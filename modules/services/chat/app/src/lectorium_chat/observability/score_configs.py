"""Declarative Langfuse score-config catalogue.

Every score the chat service writes is declared here so we can register
its config with Langfuse on startup. Configs give us:

  - validation (numeric range, categorical values),
  - UI filter dropdowns on Scores Analytics,
  - stable, human-readable labels in the trace's Scores tab.

WITHOUT a config the scores still ingest fine (Langfuse infers shape
from `data_type`); the config is purely a quality-of-life improvement
for the UI and a guard-rail against regression-noise values.

When adding a new `langfuse.create_score(...)` call site, drop a row
here too — the bootstrap that runs in the FastAPI lifespan picks the
new entry up on the next service restart (idempotent: existing configs
are skipped by `name`).

Wire `label`/`value` strings are English snake_case — they match the
exact strings the chat service sends in `create_score(value=...)`.
Localisation (e.g. Russian display strings in the mobile feedback
sheet) lives in the client's i18n bundle, NOT here. Sourcing of truth
for the lookups:

  - `user_feedback_category` labels mirror `FeedbackCategory` enum in
    `api/feedback.py`.
  - `router_intent` labels mirror the intent strings emitted by
    `agent/graph/nodes/router.py::router_node`.
"""

from __future__ import annotations

from typing import get_args

from langfuse.api import ConfigCategory

from lectorium_chat.domain.routing import Intent


# Each entry is the kwargs dict passed verbatim into
# `langfuse.api.score_configs.create(...)`. Keep `name`s globally
# unique — Langfuse keys configs by name and the bootstrap dedups on it.
SCORE_CONFIGS: list[dict] = [
    # ── User feedback (POST /chat/feedback) ────────────────────────────
    dict(
        name="user_feedback",
        data_type="BOOLEAN",
        description="Thumbs up/down from the chat UI on assistant messages",
    ),
    dict(
        name="user_feedback_category",
        data_type="CATEGORICAL",
        categories=[
            ConfigCategory(label="off_topic", value=1),
            ConfigCategory(label="no_results", value=2),
            ConfigCategory(label="bad_citations", value=3),
            ConfigCategory(label="wrong_language", value=4),
            ConfigCategory(label="factually_wrong", value=5),
            ConfigCategory(label="other", value=6),
        ],
        description="Category picked in the thumbs-down sheet (i18n on client)",
    ),
    # TEXT scores cap at 500 chars on the SDK side; we mirror the limit
    # in `FeedbackIn.comment` to fail fast at the API edge.
    dict(
        name="user_feedback_text",
        data_type="CATEGORICAL",  # TEXT data type isn't accepted by all
        # Langfuse server builds for ScoreConfig;
        # CATEGORICAL with no fixed list works.
        description="Free-form comment from the thumbs-down sheet (≤500 chars)",
    ),
    # ── Heuristic auto-scores (emit_turn_scores) ───────────────────────
    # Latency buckets — turn_total seldom exceeds 120s; first-token UX
    # budget is well under 30s. Higher caps would just hide a regression.
    dict(name="latency_total_ms", data_type="NUMERIC", min_value=0, max_value=120000),
    dict(name="first_token_ms", data_type="NUMERIC", min_value=0, max_value=30000),
    # Marker / ref quality (post-expansion audit)
    dict(name="cite_count", data_type="NUMERIC", min_value=0, max_value=50),
    dict(name="tool_calls_count", data_type="NUMERIC", min_value=0, max_value=20),
    dict(name="malformed_markers_count", data_type="NUMERIC", min_value=0, max_value=20),
    dict(name="broken_refs_count", data_type="NUMERIC", min_value=0, max_value=20),
    dict(name="bypass_markers_count", data_type="NUMERIC", min_value=0, max_value=20),
    dict(name="sentence_marker_leak_count", data_type="NUMERIC", min_value=0, max_value=20),
    dict(name="marker_validity", data_type="BOOLEAN"),
    dict(name="language_match", data_type="BOOLEAN"),
    dict(name="had_error", data_type="BOOLEAN"),
    dict(name="response_length_chars", data_type="NUMERIC", min_value=0, max_value=20000),
    # Outline shape. Emitted only when the synthesis planner actually built
    # an outline, so they are absent on action / help / catalog turns.
    dict(name="outline.n_theses", data_type="NUMERIC", min_value=0, max_value=20),
    dict(name="outline.has_intro", data_type="BOOLEAN"),
    dict(name="outline.has_conclusion", data_type="BOOLEAN"),
    dict(
        name="outline.skipped_notes_ratio",
        data_type="NUMERIC", min_value=0, max_value=1,
    ),
    # Router intent — segmentation knob for dashboards. This is a CATEGORICAL
    # config with a fixed list, so Langfuse can reject values outside it:
    # a missing label does not degrade to "uncategorised", it can drop the
    # score. Derived from `Intent` rather than retyped, because it had already
    # drifted — the four newest intents were absent and may have been invisible
    # in Scores Analytics since they shipped.
    dict(
        name="router_intent",
        data_type="CATEGORICAL",
        categories=[
            ConfigCategory(label=intent, value=i)
            for i, intent in enumerate(sorted(get_args(Intent)), start=1)
        ],
    ),
]
