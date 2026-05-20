# Spike report — LangGraph 1.2.0 behaviour

Goal: validate three architectural assumptions in
`/home/akd/.claude/plans/happy-mapping-knuth.md` (Stage 0.5) before
committing to full Stage 1 implementation.

## Environment

- `langgraph==1.2.0` (plan assumed >=0.2.50 — we got newer)
- `langchain-core==1.4.0`
- `langchain-openai==0.2.x`
- Python 3.13.12

## Questions and outcomes

### Q#2 — `as_langchain_tool` + side events via writer

**Outcome: ✅ Works as planned.**

A `ToolDef` with `emits_events=True` adapted via `as_langchain_tool`
correctly pushes side events into LangGraph's custom stream channel.
The bridge:

```python
def yield_event(ev_type, data):
    writer = get_stream_writer()
    writer({"type": ev_type, "data": data})
```

is called from inside the wrapped tool fn (kwarg-injected). When the
tool is invoked from a graph node, `get_stream_writer()` resolves to
the active stream's writer. Custom events appear in
`graph.astream(stream_mode=["custom", ...])`.

No fallback needed — the plan's section 5 streaming bridge is
implementable as written.

### Q#3 — side event ordering before next LLM token

**Outcome: ✅ Ordering is preserved.**

Inside a single node, an `await lc_tool.ainvoke(...)` that emits via
writer, followed by another `writer({...})` call for the marker
delta, produces events in code order in the consumer's `astream`
loop. Tested with `["verse_payload", "delta"]` sequence — captured
`["verse_payload", "delta"]` 100% deterministic.

This means the production pattern (worker node invokes tool → tool
emits `action.kind=verse` → node continues → synthesizer's delta
arrives) is safe: clients receive the payload before the marker that
references it.

### Q#5 — mutable `TurnAliasMap` via typed `context_schema`

**Outcome: ✅ Idiomatic, no diffing.**

LangGraph 1.2.0 has a first-class typed `context_schema` parameter on
`StateGraph()`. Nodes receive a `Runtime[TurnContext]` second argument
and access `runtime.context.aliases` etc. Crucially:

- Mutations in node A are visible by reference in node B (same Python
  instance, not a diff'd copy).
- The caller's `TurnContext` reference outside the graph reflects all
  mutations after `await graph.ainvoke(...)`.
- LangGraph does NOT attempt to checkpoint or diff the context object;
  it's treated as "injected per-run services" (matches our design
  intent in plan section 9.4).

No `configurable` fallback needed. The plan's `TurnContext` dataclass
approach is supported natively.

## Bonus combined test

A realistic end-to-end mini-flow (`test_combined_realistic_flow`):
node uses `context.aliases` → invokes side-event tool → mints local
alias → writes marker referencing the alias. All three contracts hold
simultaneously. The pattern is production-ready.

## Conclusion

**All three blockers cleared.** Stage 1 can proceed as planned with no
fallback strategies needed:

- Plan section 9.4 invariants (aliases/expander in `context`) — green.
- Plan section 11.4 streaming (`stream_mode=["custom", "messages", "updates"]` +
  writer for synthesizer) — green.
- Plan section 7 tool adapter design — green.

## Next: Stage 1 implementation

This spike validates the foundation. Next checkpoints from the plan:

1. `domain/turn_context.py` — `TurnContext` dataclass (this spike
   prototyped it; promote to real domain code).
2. `application/<role>_turn.py` — pure use-cases per worker role.
3. `agent/graph/nodes/<role>_worker.py` — thin adapters using
   `runtime.context.aliases` etc.
4. `agent/graph/builder.py` — assembles StateGraph with
   `context_schema=TurnContext`.
5. `application/chat_turn.py` — full rewrite around `graph.astream`.
