# JWT Keys

Public-key bundle for cross-region JWT verification. Every region's
auth + chat services load every region's public key from this folder
into `JWT_PUBLIC_KEYS_DIR` so a token signed anywhere is accepted
everywhere. Private keys stay on the region's own VPS and never enter
this repo.

## Trust model

- File naming: `<kid>.pub.pem`. The verifier extracts the kid from
  the filename (see `auth/internal/jwt/jwt.go:NewVerifierFromDir`).
- A token signed with `kid=global-v1` is verified against
  `global-v1.pub.pem` — wherever that file is mounted, on whichever
  region.
- Adding a new region's pubkey here, deploying everywhere, and only
  then minting tokens with the new kid is the safe rollout order.

## Files

| File | Region that signs | Trusted by |
|---|---|---|
| `russia-v1.pub.pem` | russia (Yandex Cloud — pending Wave 7) | every region |

The current global region still mints with the legacy `kid="v1"`
single-key shape from `/opt/lectorium/jwt/{private,public}.pem`. The
verifier's `NewVerifierFromDir` maps the legacy `public.pem` filename
to kid `v1`, so global tokens keep validating without a parallel
`global-v1.pub.pem` file in this folder. When global rotates (next
operator action) it will mint with `global-v2` and the new pub.pem
goes here under that name.

> The `russia-v1.pub.pem` shipped here was generated locally for the
> PR-4-prep step. The matching `russia-v1.priv.pem` is in the
> operator's password vault until Russia VPS spins up. When Russia is
> provisioned, operator must either:
>
> 1. Place the priv key at `/opt/lectorium/jwt/russia-v1.priv.pem` on
>    the Russia VPS (mode 0400, owner root) — OR
> 2. Regenerate fresh with `gen-jwt-keys.sh russia-v1` on the new
>    VPS and commit the resulting pub here (replacing this file),
>    then re-deploy global so it loads the new pubkey
>
> Either way, do this BEFORE flipping any traffic to Russia.

## Rotation runbook

Rotate a region's signing key. The example below rotates global from
the legacy single-key shape (`kid=v1`, `public.pem`) to a versioned
shape (`kid=global-v2`, `global-v2.pub.pem`).

1. **On the rotating region's VPS** generate the new keypair:
   ```bash
   sudo infra/app/scripts/gen-jwt-keys.sh global-v2
   ```
   Writes `/opt/lectorium/jwt/global-v2.priv.pem` (mode 0400) and
   `/opt/lectorium/jwt/global-v2.pub.pem` (mode 0644).

2. **Commit the new public part** to this repo:
   ```bash
   cp /opt/lectorium/jwt/global-v2.pub.pem $REPO/infra/app/jwt-keys/
   git add infra/app/jwt-keys/global-v2.pub.pem
   git commit -m "ops(jwt): trust new global-v2 signing key"
   git push
   ```

3. **Deploy on every other region first** — they pick up
   `global-v2.pub.pem` from the new commit. The multi-kid verifier
   now accepts BOTH the previous kid (`v1` from legacy `public.pem`)
   and `global-v2`-signed tokens.

4. **On the rotating region**: bump `JWT_KID=global-v2` and point
   `JWT_PRIVATE_KEY_PATH=/secrets/global-v2.priv.pem` in the compose
   env, restart the auth container. New tokens are minted with
   `global-v2`. Old tokens still validate everywhere until their
   natural exp (max 90 days for refresh).

5. **After 90 days**, retire the previous key:
   ```bash
   # If retiring the legacy single-key shape: also drop the file on
   # the origin VPS so it stops being mounted into /secrets.
   sudo rm /opt/lectorium/jwt/public.pem /opt/lectorium/jwt/private.pem
   ```
   For versioned keys, also remove the pub from this folder:
   ```bash
   git rm infra/app/jwt-keys/global-v1.pub.pem
   git commit -m "ops(jwt): retire global-v1 after 90d drain"
   ```
   Redeploy.

## Why not JWKS HTTP?

Standard OAuth uses an HTTP endpoint per issuer. We don't because:

- **Partition resilience.** Russia <-> global may be unreachable.
  File-based distribution via source control means both regions
  bootstrap independently from whatever pubkeys are committed at HEAD.
- **N small.** With 2-3 regions, source-control distribution beats
  the operational complexity of a JWKS endpoint with caching, TTLs,
  and the failure mode "verifier cannot reach issuer's JWKS".
- Trade-off accepted; revisit if N grows past ~5 regions or rotation
  becomes more frequent than once a year.
