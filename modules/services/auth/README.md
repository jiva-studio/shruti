# Shruti auth service

Stateless Go HTTP API. Issues / refreshes JWT (RS256) on behalf of users
identified by Google `sub` / Apple `sub` / `device_id`. Stores users,
identities, and refresh-tokens in a shared Postgres (`auth` schema).

Built and deployed as part of the workspace `infra/` stack — see
[`infra/README.md`](../../../infra/README.md).

## Identity model

Primary key `(provider, subject)`:

| provider | subject |
|---|---|
| `google` | Google's `sub` from id-token (~21-digit numeric ID) |
| `apple`  | Apple's `sub` from id-token (per-app stable opaque) |
| `device` | Capacitor `Device.getId()` (per-install UUID) |

Email is stored on the identity row and used as a **cross-link heuristic**
when verified: a fresh signin without prior session and with a verified
email is linked to an existing user that already has another identity with
the same verified email.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/auth/anonymous`      | opt | Bootstrap anon user/session by `deviceId`. Idempotent: returns existing session for signed-in callers. |
| `POST` | `/auth/signin/google`  | opt | Verify Google id-token, upgrade anon if Bearer present, else cross-link or create. |
| `POST` | `/auth/signin/apple`   | opt | Same as Google for Apple. Captures `fullName` on first signin. |
| `POST` | `/auth/refresh`        | —   | Rotate refresh token (single-use, SELECT FOR UPDATE for race safety). |
| `POST` | `/auth/signout`        | req | Revoke this device's refresh. |
| `GET`  | `/auth/me`             | req | Returns userId, computed email, name, identities[]. |
| `POST` | `/auth/account/delete` | req | Cascade delete user. |
| `GET`  | `/auth/healthz`        | —   | Liveness. |

JWT: RS256, `kid="v1"`. Access 15m, refresh 90d (rotated).

## Local dev

The auth service joins the workspace dev stack:

```bash
docker compose -f infra/compose/docker-compose.dev.yml up --build
curl http://localhost:8081/auth/healthz
```

## Configuration

Env vars (all wired through `infra/.env`):

| Var | Purpose |
|---|---|
| `DATABASE_URL` | postgres://... |
| `JWT_PRIVATE_KEY_PATH` | RSA private PEM (default `/secrets/private.pem`) |
| `JWT_PUBLIC_KEY_PATH`  | RSA public PEM  (default `/secrets/public.pem`)  |
| `JWT_KID` | Key id in JWT header. Default `v1`. |
| `GOOGLE_CLIENT_IDS` | Comma-separated Google OAuth client IDs (Android/iOS/Web). |
| `APPLE_BUNDLE_IDS`  | Comma-separated Apple bundle / service IDs. |
| `PORT` | Default 8081. |

JWT keys are workspace-wide (`../.config/shruti/jwt/`) so they stay the
same across hosts — see [`infra/scripts/gen-jwt-keys.sh`](../../../infra/scripts/gen-jwt-keys.sh).

## Layout

```
modules/services/auth/
├── cmd/auth/main.go              # entry + healthz subcommand for HEALTHCHECK
├── internal/
│   ├── config/                   # env loader
│   ├── handler/                  # chi router, bearer middleware (TBD)
│   ├── service/                  # business logic (TBD)
│   ├── store/                    # pgx repos (TBD)
│   ├── jwt/                      # RS256 sign/verify (TBD)
│   └── providers/{google,apple}/ # id-token verifiers (TBD)
├── migrations/                   # golang-migrate SQL (TBD)
├── Dockerfile                    # multi-stage → FROM scratch ~15MB
├── go.mod, go.sum
└── README.md
```
