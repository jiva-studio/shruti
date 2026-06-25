-- Billing service schema. The order row is the source of truth for a crypto
-- (Paymento) PRO purchase and drives a resilient state machine
-- (created → verified → granted → fulfilled, + expired/failed). Every external
-- effect (Paymento verify, auth grant) is re-drivable from this row by the
-- reconcile worker, so a payment that completed while billing/auth was down
-- still self-heals — IPN delivery is never trusted on its own.
CREATE SCHEMA IF NOT EXISTS billing;

CREATE TABLE billing.orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL,
    plan text NOT NULL,                 -- 'monthly' | 'yearly'
    amount_cents int NOT NULL,
    currency text NOT NULL DEFAULT 'USD',
    paymento_token text,
    paymento_payment_id text UNIQUE,
    status text NOT NULL DEFAULT 'created',
    attempts int NOT NULL DEFAULT 0,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    granted_at timestamptz
);

CREATE INDEX billing_orders_status_idx ON billing.orders(status);
