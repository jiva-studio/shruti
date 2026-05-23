# Langfuse `user_id` source

## Decision

`Langfuse.trace(user_id=...)` is bound to the **internal UUID from the
JWT `sub` claim** — i.e. `VerifiedUser.id`, which is already extracted
on every `/chat` request by `api/_auth.get_current_user`.

No new database tables, no device-id hashing, no apple_id/google_play_id
plumbing through to the trace. The auth service already mints these
UUIDs and the chat service already verifies them.

## Why this works for Shruti

- `infra/auth/jwt_verifier.py` enforces `RS256` and requires the `sub`
  claim. `sub` is the user UUID issued by the auth service (both for
  signed-in users and for `/auth/anonymous` bootstrap JWTs — anonymous
  users get a stable UUID per device install).
- `api/chat.py` already binds `user_id=user.id` to the structlog
  context, so logs and Langfuse traces share the same identifier.
- Anonymous-bootstrap users still get a stable UUID, so trace grouping
  by user works end-to-end without a separate device-hash table.

## What the trace gets

```python
langfuse.trace(
    id=langfuse_trace_id,            # uuid4 per turn, NOT request_id
    user_id=user_ctx.user_id,        # = VerifiedUser.id = sub claim
    session_id=conversation_id,      # threading across turns (TBD)
)
```

`user_ctx.user_id` is the new field on `domain.UserContext` populated
at the API boundary from `VerifiedUser.id`.

## What is NOT in the trace

- `apple_id`, `google_play_id`, email, phone, real name — these never
  leave the auth service. The chat service only ever sees the opaque
  UUID. The structlog `drop_pii` processor (Phase 6) belt-and-braces
  this by stripping the sensitive keys from any log dict that somehow
  ends up carrying them.
