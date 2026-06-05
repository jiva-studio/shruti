"""Code-driven research pipeline.

Replaces the LLM-driven ReAct loop (`application/react_loop.py`, formerly
`react_loop.py`) for `router.intent == "research"` turns. Deterministic
orchestrator with explicit timeouts and a two-path execution model:

  SHORT path (question-attribution match):
    plan_queries → find_attributions(kind=pinned) → fetch_refs (authoritative)
    + supplementary fanout → synthesizer

  LONG path (no question match):
    plan_queries → extract_topics → find_attributions(kind=boost) → fanout
    with topic-boost (+0.15 on chunks whose item_id is referenced by a
    matched topic-attribution) + coverage gate + up-to-N rounds → synthesizer

Cold start (empty attribution table) reduces cleanly to plain fanout.
"""
