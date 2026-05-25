-- Rate-limit usage counters move to Redis (chat: RedisRateLimitStore,
-- share-video: redislimit). The day-bucketed Postgres table goes away.
-- Orphan keys self-clean via the per-key TTL.

DROP TABLE IF EXISTS usage;
