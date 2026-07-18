"""Re-upload the no-cover-intro Shorts after the intro versions were deleted.

First clip -> PUBLIC immediately (to watch it today); the rest -> private +
publishAt, 2/day from tomorrow (08:00 & 13:30 UTC). Sets the cover as the
thumbnail. Resumable via youtube_uploaded_v2.json.

Env: CLIPS_FILE (JSON list of clip ids, in order). Uses token.json from ../youtube.
"""
import json
import os
from datetime import datetime, timedelta, timezone

from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload
from googleapiclient.errors import HttpError

HERE = os.path.dirname(os.path.abspath(__file__))
YT = os.path.join(HERE, "..", "youtube")
RES = "/home/akd/Projects/jiva-studio/shruti/resources/shorts"
SCOPES = ["https://www.googleapis.com/auth/youtube.upload",
          "https://www.googleapis.com/auth/youtube.readonly"]
SLOTS = [(8, 0), (13, 30)]           # 2/day, UTC
STATE = f"{RES}/youtube_uploaded_v2.json"

clips = json.load(open(os.environ["CLIPS_FILE"]))
jobs = {j["id"]: j for j in json.load(open(f"{HERE}/jobs.json"))}

creds = Credentials.from_authorized_user_file(f"{YT}/token.json", SCOPES)
if not creds.valid and creds.refresh_token:
    creds.refresh(Request())
yt = build("youtube", "v3", credentials=creds)

# scheduled slots for clips[1:] — start tomorrow, 2/day
now = datetime.now(timezone.utc)
day = (now + timedelta(days=1)).date()
slots = []
while len(slots) < len(clips) - 1:
    for h, m in SLOTS:
        slots.append(datetime(day.year, day.month, day.day, h, m, tzinfo=timezone.utc))
    day += timedelta(days=1)

out = json.load(open(STATE)) if os.path.exists(STATE) else {}
for i, cid in enumerate(clips):
    if cid in out:
        continue
    meta = json.load(open(f"{RES}/meta/{cid}.json"))
    video = f"{RES}/video/{cid}.mp4"
    if i == 0:
        status = {"privacyStatus": "public", "selfDeclaredMadeForKids": False}
        when = "PUBLIC now"
    else:
        w = slots[i - 1].strftime("%Y-%m-%dT%H:%M:%SZ")
        status = {"privacyStatus": "private", "publishAt": w, "selfDeclaredMadeForKids": False}
        when = w
    body = {"snippet": {"title": meta["title"], "description": meta["description"],
                        "tags": meta.get("tags", []), "categoryId": "22"},
            "status": status}
    try:
        req = yt.videos().insert(part="snippet,status", body=body,
                                 media_body=MediaFileUpload(video, chunksize=-1, resumable=True))
        resp = None
        while resp is None:
            _, resp = req.next_chunk()
        vid = resp["id"]
        try:
            yt.thumbnails().set(videoId=vid,
                                media_body=MediaFileUpload(f"{RES}/cover/{cid}.jpg")).execute()
        except HttpError as e:
            print("  thumb warn:", str(e)[:80])
        out[cid] = {"video_id": vid, "when": when}
        json.dump(out, open(STATE, "w"), indent=1)
        print(f"[{when}] {cid} -> https://youtu.be/{vid}")
    except HttpError as e:
        if "quota" in str(e).lower():
            print(f"\nDAILY QUOTA REACHED after {len(out)} — re-run later."); break
        print("ERROR", cid, str(e)[:160])

print(f"\nuploaded {len(out)}/{len(clips)}")
