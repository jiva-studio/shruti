# Security policy

Shruti runs a live backend and ships a mobile app that handles user
accounts and payments, so a flaw in this repository can affect real people.
Please report one privately.

## Reporting a vulnerability

Use GitHub's private reporting: **Security → Report a vulnerability** on this
repository. That opens a draft advisory only the maintainers can see.

If that is unavailable, email **support@jiva.studio** with `SECURITY` in the
subject. Please do not open a public issue, and please do not post details on
social media before a fix ships.

A useful report says what you did, what happened, and why it matters — ideally
a request/response pair or a short proof of concept, the affected endpoint or
file, and the version or commit you tested.

## What to expect

- Acknowledgement within **3 working days**.
- An assessment, and a fix or a decision not to fix, within **30 days** for
  anything exploitable against the production service.
- Credit in the advisory unless you prefer otherwise.
- Public disclosure through a GitHub Security Advisory once a fix is
  available, or after **90 days**, whichever comes first. If a fix needs
  longer, we will say so rather than let the clock run out silently.

There is no bug bounty. This is a small project; what we can offer is a
prompt, honest answer and credit.

## Scope

In scope: this repository's code, and the production services it deploys
(`auth`, `chat`, `profile`, `orchestrator`, `discovery`, the `share-*`
services and the public corpus MCP).

Out of scope: findings that require a rooted or jailbroken device to reach
client-side entitlement checks — the server is the authority and those checks
are cosmetic; denial of service by volume; missing hardening headers with no
demonstrated impact; and reports from automated scanners with no working
proof of concept.

**Please do not test against production.** Rate limits, account deletion and
the ingest pipeline all cost real money and touch real user data. Describe the
issue and we will reproduce it.

## Supported versions

Only the current `main` and the latest published mobile release receive
security fixes. Older releases are not patched.
