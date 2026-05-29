# JWT Keys

Public-key bundle for JWT verification on hosts that don't sign tokens
(i.e. share-audio / share-video on the proxy VPS). The committed
`*.pub.pem` files are synced into `/opt/lectorium/jwt/` on each host by
`deploy.sh`.

The matching private key is generated on the origin VPS and stays there
(see `infra/app/scripts/gen-jwt-keys.sh --prod`). It NEVER enters this
repo.

## Files

| File | Signed by | Verified by |
|---|---|---|
| `v1.pub.pem` | origin VPS (auth service) | every service on every host |

## Rotation

1. **In-place re-issue** (no kid change): generate a fresh keypair on
   the origin VPS, commit the new `v1.pub.pem`, redeploy. All previously
   issued tokens become invalid → clients re-signin. Cheap, disruptive.
2. **Versioned rotation** (`v1` → `v2`): generate new keypair as `v2`,
   commit `v2.pub.pem` here, deploy everywhere (so every verifier
   trusts both `v1` and `v2`), then flip auth to sign with `v2`. After
   90 days (refresh-token TTL), drop `v1.pub.pem` from this folder.
   Requires re-introducing a multi-kid verifier — not present today.
