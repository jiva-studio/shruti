-- Restore the pre-0024 schema verbatim from 0013_chat_usage.up.sql.
CREATE TABLE usage (
    key   TEXT NOT NULL,
    day   DATE NOT NULL,
    count INT NOT NULL DEFAULT 0,
    PRIMARY KEY (key, day)
);
