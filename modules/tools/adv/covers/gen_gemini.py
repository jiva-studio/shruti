"""Generate a thumbnail image via OpenRouter's Gemini image model.
Usage: gen_thumb_gemini.py <prompt_file> <out.png> [ref_image ...]
Env: OPENROUTER_API_KEY
"""
import base64
import json
import os
import sys
import urllib.request

KEY = os.environ["OPENROUTER_API_KEY"]
MODEL = os.environ.get("IMG_MODEL", "google/gemini-2.5-flash-image")

prompt = open(sys.argv[1]).read()
out = sys.argv[2]
refs = sys.argv[3:]

content = [{"type": "text", "text": prompt}]
for r in refs:
    b = base64.b64encode(open(r, "rb").read()).decode()
    ext = "png" if r.lower().endswith("png") else "jpeg"
    content.append({"type": "image_url", "image_url": {"url": f"data:image/{ext};base64,{b}"}})

body = {
    "model": MODEL,
    "messages": [{"role": "user", "content": content}],
    "modalities": ["image", "text"],
}
req = urllib.request.Request(
    "https://openrouter.ai/api/v1/chat/completions",
    data=json.dumps(body).encode(),
    headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
)
resp = json.load(urllib.request.urlopen(req, timeout=120))
msg = resp["choices"][0]["message"]

imgs = msg.get("images") or []
if not imgs and isinstance(msg.get("content"), list):
    imgs = [p for p in msg["content"] if p.get("type") == "image_url"]

if not imgs:
    print("NO IMAGE. text:", (msg.get("content") if isinstance(msg.get("content"), str) else "")[:500])
    sys.exit(2)

url = imgs[0]["image_url"]["url"]
data = url.split(",", 1)[1]
open(out, "wb").write(base64.b64decode(data))
print("saved", out, os.path.getsize(out), "bytes")
