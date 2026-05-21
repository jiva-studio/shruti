"""Code-driven research pipeline.

Replaces the LLM-driven ReAct loop (`application/react_loop.py`, formerly
`research_turn.py`) for `router.intent == "research"` turns. Deterministic
orchestrator with explicit timeouts and a two-path execution model:

  SHORT path (question-attribution match):
    expand_query → find_attributions(kind=question) → fetch_refs (authoritative)
    + supplementary fanout → synthesizer

  LONG path (no question match):
    expand_query → extract_topics → find_attributions(kind=topic) → fanout
    with topic-boost (+0.15 on chunks whose item_id is referenced by a
    matched topic-attribution) + coverage gate + up-to-N rounds → synthesizer

Cold start (empty attribution table) reduces cleanly to plain fanout.
"""
