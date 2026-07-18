"""One-time OAuth consent -> saves token.json (refresh token) for uploads.

Run:  .venv/bin/python get_token.py client_secret.json
Opens a browser; sign in with the account that owns the target channel and
click Allow. If that account manages several channels (a Brand Account),
pick the right channel when prompted.
"""
import sys

from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.readonly",
]

secret = sys.argv[1] if len(sys.argv) > 1 else "client_secret.json"
flow = InstalledAppFlow.from_client_secrets_file(secret, SCOPES)
creds = flow.run_local_server(port=0, prompt="consent")
with open("token.json", "w") as f:
    f.write(creds.to_json())
print("OK - saved token.json")
