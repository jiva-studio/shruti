-- What a model call cost, as the provider reported it.
--
-- Every reply carries its token counts and its price, and the service was
-- discarding all three. Every statement about what this corpus costs to index
-- has therefore been arithmetic — my $75 estimate turned out to be $25 on the
-- actual bill, and there was no way to tell until it arrived.

CREATE TABLE IF NOT EXISTS discovery.spend (
    id         bigserial PRIMARY KEY,
    run_id     bigint REFERENCES discovery.runs(id) ON DELETE SET NULL,
    source_id  text,
    -- What the call was for: "normalize" reads a page's files, "series" asks
    -- whether a page presents a cycle.
    kind       text NOT NULL,
    model      text NOT NULL,
    -- How many recordings this one call covered. A call answering one file
    -- pays the whole system prompt for it.
    items      integer NOT NULL DEFAULT 0,
    -- Null where the provider said nothing, which is not the same as free. A
    -- zero here would be a price; a null is an absence, and the two must not be
    -- added up together.
    tokens_in  bigint,
    tokens_out bigint,
    cost_usd   numeric(12,6),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS spend_source_idx ON discovery.spend (source_id, created_at DESC);
