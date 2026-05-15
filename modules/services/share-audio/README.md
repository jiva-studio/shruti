# share-audio

Serverless function that cuts a fragment from an MP3 stored in **AWS S3** and
uploads it back as a public excerpt under `public/excerpts/`. Same Python
handler deploys to **AWS Lambda** and **Yandex Cloud Functions** via the
[Serverless Framework].

Source and excerpt live in the **same single bucket**. The cloud only
provides compute. Lambda accesses S3 via its IAM role; the YC Function uses
a dedicated AWS IAM user (YC service accounts can't sign AWS S3 requests).

## API

`POST /excerpts`

```json
{
  "source_key": "audio/lectures/2025-01-15.mp3",
  "start_ms": 125000,
  "end_ms": 187000,
  "excerpt_id": "optional-stable-id"
}
```

`200 OK`

```json
{
  "excerpt_id": "abc123",
  "url": "https://<bucket>.s3.<region>.amazonaws.com/public/excerpts/abc123.mp3",
  "ready": true
}
```

The function downloads the source, runs `ffmpeg -c copy` to extract
`[start_ms, end_ms]`, uploads the result with public-read ACL, and returns the
URL. The mobile client uses the URL directly or `HEAD`s it to confirm
readiness.

If the same `excerpt_id` is requested again, the function returns the existing
URL without re-cutting (idempotent).

## Limits

- Excerpt length: ≤ 10 minutes (Yandex Cloud Functions hard timeout).
- MP3 stream copy only — cuts snap to MP3 frame boundaries (~26 ms).

## Deploy

```bash
npm install
npm run deploy:aws   # → AWS Lambda + API Gateway
npm run deploy:yc    # → Yandex Cloud Function + API Gateway
```

Both deploys use the same `handler.py`, `storage.py`, `event_adapter.py`,
and `requirements.txt`. Only the `serverless-*.yml` differs.

## Runtime environment variables

| Var                    | AWS Lambda                       | YC Function                      |
| ---------------------- | -------------------------------- | -------------------------------- |
| `BUCKET`               | hardcoded `shruti-engine`       | same (single bucket both clouds) |
| `EXCERPTS_PREFIX`      | default `public/excerpts`        | same                             |
| `EXCERPTS_PUBLIC_BASE` | optional CDN base (env)          | same                             |
| `AWS_REGION`           | from Lambda runtime              | from `AWS_RUNTIME_REGION` var    |
| AWS credentials        | Lambda IAM role (no env)         | `AWS_RUNTIME_*` secrets          |
| `FFMPEG_BIN`           | layer-mounted path (default)     | bundled binary path              |

## CI

- `.github/workflows/share-audio-aws.yml` — auto-deploys to AWS on push to
  `main` (path-filtered). Validates on PRs. Uses `production` environment.
- `.github/workflows/share-audio-yc.yml` — `workflow_dispatch` only;
  disabled until YC creds are added (see header comments in the file).

### AWS deploy — already configured

- **Org-level** (`jiva-studio`) secrets: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` — Lambda deploy target.
- Bucket name (`shruti-engine`) is hardcoded in `serverless-aws.yml`. No repo vars required for AWS.

### YC deploy — secrets/vars still to add

- **Repo secrets**:
  - `YC_OAUTH_TOKEN`, `YC_SERVICE_ACCOUNT_ID` — YC deploy + runtime SA.
  - `AWS_RUNTIME_ACCESS_KEY_ID`, `AWS_RUNTIME_SECRET_ACCESS_KEY` — dedicated IAM user with `s3:GetObject` + `s3:PutObject` + `s3:PutObjectAcl` on `shruti-engine`. Used by boto3 inside the YC function (YC service accounts can't sign AWS S3 requests).
- **Repo vars**:
  - `YC_FOLDER_ID`, `AWS_RUNTIME_REGION`.

[Serverless Framework]: https://www.serverless.com/
