"""Upload the finalized batch to YouTube, scheduled (publishAt), quota-aware.

YouTube allows ~6 inserts/day (1600 units each, 10k/day). This uploads until
the daily quota is hit, records progress in <BATCH>/uploaded.json, and can be
re-run on later days to drain the rest. publishAt is a stable per-clip schedule
(computed once into <BATCH>/schedule.json) so reruns keep the same air dates.

Env: BATCH_DIR. Uses token.json from ../youtube.
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
BATCH = os.environ["BATCH_DIR"]
RES = "/home/akd/Projects/jiva-studio/shruti/resources/shorts"
SCOPES = ["https://www.googleapis.com/auth/youtube.upload",
          "https://www.googleapis.com/auth/youtube.readonly"]

# Two publish slots per day (UTC), tuned for the India-en prime time
# (13:30 & 19:00 IST). publishAt is quota-independent, so we can spread the
# whole batch across days even though the API only lets us INSERT ~6/day.
SLOTS_UTC = [(8, 0), (13, 30)]
MIN_LEAD_H = 2        # never schedule a publish sooner than +2h from now

jobs = json.load(open(f"{HERE}/jobs.json"))
order = [j["id"] for j in jobs]

sched_path = f"{BATCH}/schedule.json"
if os.path.exists(sched_path):
    schedule = json.load(open(sched_path))
else:
    now = datetime.now(timezone.utc)
    floor = now + timedelta(hours=MIN_LEAD_H)
    slots, day = [], now.date()
    while len(slots) < len(order):
        for h, m in SLOTS_UTC:
            cand = datetime(day.year, day.month, day.day, h, m, tzinfo=timezone.utc)
            if cand > floor:
                slots.append(cand)
        day += timedelta(days=1)
    schedule = {vid: slots[i].strftime("%Y-%m-%dT%H:%M:%SZ") for i, vid in enumerate(order)}
    json.dump(schedule, open(sched_path, "w"), indent=1)

up_path = f"{BATCH}/uploaded.json"
uploaded = json.load(open(up_path)) if os.path.exists(up_path) else {}

creds = Credentials.from_authorized_user_file(f"{YT}/token.json", SCOPES)
if not creds.valid and creds.refresh_token:
    creds.refresh(Request())
yt = build("youtube", "v3", credentials=creds)

for vid in order:
    if vid in uploaded:
        continue
    video = f"{RES}/video/{vid}.mp4"
    meta = json.load(open(f"{RES}/meta/{vid}.json"))
    if not os.path.exists(video):
        print("no final, skip", vid)
        continue
    body = {
        "snippet": {"title": meta["title"], "description": meta["description"],
                    "tags": meta.get("tags", []), "categoryId": "22"},
        "status": {"privacyStatus": "private", "publishAt": schedule[vid],
                   "selfDeclaredMadeForKids": False},
    }
    try:
        req = yt.videos().insert(part="snippet,status", body=body,
                                 media_body=MediaFileUpload(video, chunksize=-1, resumable=True))
        resp = None
        while resp is None:
            _, resp = req.next_chunk()
        vidid = resp["id"]
        # cover as the 16:9 thumbnail too (search/suggested surfaces)
        try:
            yt.thumbnails().set(videoId=vidid,
                                media_body=MediaFileUpload(f"{RES}/cover/{vid}.jpg")).execute()
        except HttpError as e:
            print("  thumb warn:", str(e)[:80])
        uploaded[vid] = {"video_id": vidid, "publish_at": schedule[vid]}
        json.dump(uploaded, open(up_path, "w"), indent=1)
        print(f"uploaded {vid} -> https://youtu.be/{vidid}  publish {schedule[vid]}")
    except HttpError as e:
        if "quota" in str(e).lower():
            print(f"\nDAILY QUOTA REACHED after {len(uploaded)} uploads — re-run tomorrow.")
            break
        print("ERROR", vid, str(e)[:160])

print(f"\nuploaded so far: {len(uploaded)}/{len(order)}")
