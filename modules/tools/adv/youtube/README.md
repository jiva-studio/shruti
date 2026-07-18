# youtube

A small, generic **video uploader** for YouTube (Data API v3). It uploads a
single video file with the title/description/tags you pass in. It knows
nothing about how the video was produced — cutting clips, audio, rendering
are all separate concerns.

## One-time setup (manual, in Google Cloud)

1. Open <https://console.cloud.google.com>, create or pick a project.
2. **Enable** the *YouTube Data API v3* (APIs & Services → Library).
3. **OAuth consent screen**: User type *External*; fill app name + support
   email; under *Test users* add the Google account that owns the target
   channel. Leaving publishing status on *Testing* is fine — a test user can
   still authorize.
4. **Credentials → Create credentials → OAuth client ID**, application type
   **Desktop app**. Download the JSON as `client_secret.json` into this dir.

## Authorize (one time, produces a refresh token)

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python get_token.py client_secret.json
```

A browser opens — sign in with the account that owns the channel and click
**Allow**. If that account manages several channels (a Brand Account), pick
the right one. This writes `token.json` (the refresh token). Keep both
`client_secret.json` and `token.json` out of git (see `.gitignore`); the
long-term home for them is Secret Manager.

## Upload

```sh
.venv/bin/python upload.py metadata.json /path/to/video.mp4
```

It prints the **authorized channel** (confirm it's the right one) and the
resulting video URL. Default privacy is `unlisted` — review it in YouTube
Studio, then flip to public there or set `"privacy": "public"` in the JSON.

`metadata.json`:

```json
{
  "title": "…",
  "description": "…",
  "tags": ["…", "…"],
  "categoryId": "22",
  "privacy": "unlisted"
}
```

## Quota

An upload costs **1600** units; the default daily quota is 10 000 → about
**6 uploads/day**. Request a higher quota in Cloud Console for larger batches.
