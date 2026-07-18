"""Set a custom thumbnail on a video: set_thumbnail.py VIDEO_ID image.jpg
Needs token.json. Requires the channel to be verified (phone) for custom
thumbnails; otherwise the API returns 403.
"""
import sys

from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
]

video_id, image = sys.argv[1], sys.argv[2]
creds = Credentials.from_authorized_user_file("token.json", SCOPES)
if not creds.valid and creds.refresh_token:
    creds.refresh(Request())
yt = build("youtube", "v3", credentials=creds)
yt.thumbnails().set(videoId=video_id, media_body=MediaFileUpload(image)).execute()
print("thumbnail set for", video_id)
