# 1Password secret template for the LOCAL dev stack — resolved at launch by
# `op run` (see `make stack-up`). Contains NO secrets, only references; safe to
# commit. Each value points at a field of the `Dev :: App` item in the
# `Lectorium` vault (field labels == the env var name). `op run` injects the
# resolved values into the `docker compose` process env, where the dev overlay
# (`docker-compose.dev.yml`, x-op-secrets) passes them through to the
# containers — so secrets never touch `.env.dev` on disk.
#
# Requires the `Dev :: App` item to exist & be populated, and 1Password
# unlocked (desktop integration or OP_SERVICE_ACCOUNT_TOKEN). The `::` in the
# title (not `/`) keeps the op:// path single-segment.
OPENROUTER_API_KEY=op://Lectorium/Dev :: App/OPENROUTER_API_KEY
AWS_ACCESS_KEY_ID=op://Lectorium/Dev :: App/AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY=op://Lectorium/Dev :: App/AWS_SECRET_ACCESS_KEY
LANGFUSE_HOST=op://Lectorium/Dev :: App/LANGFUSE_HOST
LANGFUSE_PUBLIC_KEY=op://Lectorium/Dev :: App/LANGFUSE_PUBLIC_KEY
LANGFUSE_SECRET_KEY=op://Lectorium/Dev :: App/LANGFUSE_SECRET_KEY
LECTORIUM_RC_REST_API_KEY=op://Lectorium/Dev :: App/LECTORIUM_RC_REST_API_KEY
LECTORIUM_RC_WEBHOOK_SECRET=op://Lectorium/Dev :: App/LECTORIUM_RC_WEBHOOK_SECRET
VOYAGE_API_KEY=op://Lectorium/Dev :: App/VOYAGE_API_KEY
LECTORIUM_OPENAI_API_KEY=op://Lectorium/Dev :: App/LECTORIUM_OPENAI_API_KEY
