-- Idempotency ledger for server-to-server promotional grants
-- (Paymento crypto billing → POST /internal/subscription/grant).
--
-- Without it, a grant whose RevenueCat call landed but whose HTTP response was
-- lost is re-driven by the billing reconcile worker and extends the entitlement
-- a SECOND time for a single payment: GrantAndApply computes the new expiry as
-- max(now, current_expiry) + period, so a re-drive stacks on the
-- already-extended expiry.
--
-- grant_key is the billing order id. We persist the absolute end_time computed
-- on the FIRST attempt and reuse it on every re-drive, so re-applying the grant
-- is a no-op at RevenueCat (GrantPromotional replaces the expiry with the same
-- absolute value) — idempotent in both directions: no double-grant, and no
-- under-grant if the first attempt failed before RC.
CREATE TABLE auth.subscription_grants (
  grant_key     TEXT        PRIMARY KEY,
  user_id       UUID        NOT NULL,
  duration      TEXT        NOT NULL,
  granted_until TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
