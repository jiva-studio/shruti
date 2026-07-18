"""Upload one video to YouTube via the Data API v3. Generic — the video and
its metadata are inputs; this tool knows nothing about how they were made.

Run:  .venv/bin/python upload.py metadata.json video.mp4
Needs token.json (from get_token.py) in the cwd. Prints the authorized
channel first so you can confirm the target before it goes live. Defaults to
privacyStatus=unlisted (override in the metadata json).

metadata.json shape:
  {
    "title": "...",
    "description": "...",
    "tags": ["...", "..."],
    "categoryId": "22",        # optional, default People & Blogs
    "privacy": "unlisted"      # optional: unlisted | private | public
  }
"""
import json
import sys

from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
]

meta_path, video_path = sys.argv[1], sys.argv[2]
meta = json.load(open(meta_path))

creds = Credentials.from_authorized_user_file("token.json", SCOPES)
if not creds.valid and creds.refresh_token:
    creds.refresh(Request())

yt = build("youtube", "v3", credentials=creds)

# Sanity check: which channel does this token upload to?
me = yt.channels().list(part="snippet", mine=True).execute()
if me.get("items"):
    ch = me["items"][0]
    print(f"authorized channel: {ch['snippet']['title']} ({ch['id']})")

status = {
    "privacyStatus": meta.get("privacy", "unlisted"),
    "selfDeclaredMadeForKids": False,
}
# Scheduled publish: publishAt (RFC3339, future) requires private status;
# YouTube flips it to public automatically at that time.
if meta.get("publishAt"):
    status["privacyStatus"] = "private"
    status["publishAt"] = meta["publishAt"]

body = {
    "snippet": {
        "title": meta["title"],
        "description": meta["description"],
        "tags": meta.get("tags", []),
        "categoryId": meta.get("categoryId", "22"),  # People & Blogs
    },
    "status": status,
}

req = yt.videos().insert(
    part="snippet,status",
    body=body,
    media_body=MediaFileUpload(video_path, chunksize=-1, resumable=True),
)
resp = None
while resp is None:
    status, resp = req.next_chunk()
    if status:
        print(f"  {int(status.progress() * 100)}%")
print("uploaded:", resp["id"], "->", f"https://youtu.be/{resp['id']}")
print("privacy:", body["status"]["privacyStatus"])
if meta.get("publishAt"):
    print("scheduled public at:", meta["publishAt"])
