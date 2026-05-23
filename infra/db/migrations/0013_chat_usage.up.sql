-- Generic per-day usage counters. Used by chat for per-user rate-limit
-- (key format: `<scope>:user:<sub>` or `<scope>:ip:<ip>`), and by share-video
-- for per-user daily render quotas (`share_video:user:<sub>`). Day-bucketed,
-- UTC midnight reset.

CREATE TABLE usage (
    key   TEXT NOT NULL,
    day   DATE NOT NULL,
    count INT NOT NULL DEFAULT 0,
    PRIMARY KEY (key, day)
);
