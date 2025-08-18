#!/usr/bin/env python3
import re
import json
import argparse
import requests
import boto3

# ==== CONFIGURATION ====
COUCH_URL       = ""
DB_NAME         = ""
S3_BUCKET       = ""
S3_ENDPOINT_URL = ""
S3_REGION       = ""
S3_ACCESS_KEY   = ""
S3_SECRET_KEY   = ""
# ========================

# Setup S3 client
s3 = boto3.client(
    "s3",
    endpoint_url=S3_ENDPOINT_URL,
    region_name=S3_REGION,
    aws_access_key_id=S3_ACCESS_KEY,
    aws_secret_access_key=S3_SECRET_KEY
)

def extract_block_number(block_id):
    m = re.search(r"\d+", block_id)
    return int(m.group()) if m else None

def fetch_transcript(track_id):
    key = f"library/tracks/{track_id}/transcripts/ru.json"
    try:
        obj = s3.get_object(Bucket=S3_BUCKET, Key=key)
        return json.load(obj["Body"])
    except Exception as e:
        print(f"⚠️ Failed to fetch transcript for {track_id}: {e}")
        return None

def update_doc(doc, dry_run=False):
    track_id = doc.get("trackId")
    blocks = doc.get("blocks", [])
    if not track_id or not blocks:
        return

    block_nums = list(filter(None, [extract_block_number(b) for b in blocks]))
    if not block_nums:
        return

    min_idx = min(block_nums)
    max_idx = max(block_nums)

    transcript = fetch_transcript(track_id)
    if not transcript:
        return

    try:
        t_blocks = transcript["blocks"]
        time_start = t_blocks[min_idx]["start"]
        time_end = t_blocks[max_idx]["end"]
    except (IndexError, KeyError) as e:
        print(f"❌ Index error for track {track_id}: {e}")
        return

    # Prepare new doc
    new_doc = dict(doc)
    new_doc["timeStart"] = time_start
    new_doc["timeEnd"] = time_end
    # new_doc.pop("blocks", None)

    doc_id = doc["_id"]
    doc_rev = doc["_rev"]

    if dry_run:
        print(f"🧪 Dry-run: would update {doc_id} with timeStart={time_start}, timeEnd={time_end}")
        return

    # PUT full doc
    url = f"{COUCH_URL}/{DB_NAME}/{doc_id}"
    headers = {"Content-Type": "application/json"}
    try:
        pass
        resp = requests.put(url, headers=headers, data=json.dumps(new_doc), verify=False)
        resp.raise_for_status()
        print(f"✅ Updated {doc_id}")
    except Exception as e:
        print(f"❌ Failed to update {doc_id}: {e}")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    # Mango query
    url = f"{COUCH_URL}/{DB_NAME}/_find"
    headers = {"Content-Type": "application/json"}
    query = {
        "selector": {
            "type": {"$eq": "note"}
        },
        "limit": 9999  # Increase if needed
    }

    try:
        resp = requests.post(url, headers=headers, data=json.dumps(query), verify=False)
        resp.raise_for_status()
        docs = resp.json()["docs"]
    except Exception as e:
        print(f"❌ Failed to fetch docs: {e}")
        return

    for doc in docs:
        update_doc(doc, dry_run=args.dry_run)

if __name__ == "__main__":
    main()