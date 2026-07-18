"""Proofread the batch: LLM-check each clip's transcript for coherence, drop the
junk, and lightly clean the text. Reads <BATCH>/svjobs.json, writes
<BATCH>/svjobs.keep.json (keepers only) and prints a keep/drop report.

Env: OPENROUTER_API_KEY, BATCH_DIR
"""
import json
import os
import urllib.request

BATCH = os.environ["BATCH_DIR"]
KEY = os.environ["OPENROUTER_API_KEY"]
MODEL = os.environ.get("LLM_MODEL", "google/gemini-2.5-flash")

THRESHOLD = int(os.environ.get("SCORE_MIN", "6"))
SYS = (
    "You judge whether a short vertical-video clip actually ANSWERS its thumbnail question. "
    "You get the QUESTION (the provoking hook shown to the viewer) and the TRANSCRIPT of the clip "
    "(Srila Prabhupada speaking). Rate 1-10 how directly and satisfyingly the clip answers THAT "
    "specific question: 10 = clearly and satisfyingly answers it; 5 = related but doesn't really "
    "answer; 1 = unrelated, cut off, or dominated by untranslated Sanskrit / broken text. Return "
    'strict JSON: {"score": <1-10 int>, "reason": "<short>"}.')


def llm(question, text):
    payload = json.dumps({"QUESTION": question, "TRANSCRIPT": text})
    body = {"model": MODEL, "temperature": 0.2,
            "response_format": {"type": "json_object"},
            "messages": [{"role": "system", "content": SYS},
                         {"role": "user", "content": payload}]}
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
    r = json.load(urllib.request.urlopen(req, timeout=90))
    return json.loads(r["choices"][0]["message"]["content"])


sv = json.load(open(f"{BATCH}/svjobs.json"))
scored = []
for j in sv:
    try:
        g = llm(j["header"], j["text"])
    except Exception as e:
        print("ERR", j["video_id"], e)
        continue
    s = int(g.get("score", 0))
    scored.append((s, j, g.get("reason", "")))

scored.sort(key=lambda x: -x[0])
keep = []
for s, j, reason in scored:
    mark = "KEEP" if s >= THRESHOLD else "DROP"
    print(f"{mark} {s}/10  {j['header'][:34]:34} | {reason[:56]}")
    if s >= THRESHOLD:
        keep.append(j)

json.dump(keep, open(f"{BATCH}/svjobs.keep.json", "w"), ensure_ascii=False, indent=1)
print(f"\nkept {len(keep)}/{len(sv)}  (threshold {THRESHOLD}/10)")
